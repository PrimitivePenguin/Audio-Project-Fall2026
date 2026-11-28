package com.cmpt276group18.audio_project.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.InOrder;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import com.cmpt276group18.audio_project.service.ProjectService;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectAccessException;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectNotFoundException;
import com.cmpt276group18.audio_project.service.R2StorageService;
import com.cmpt276group18.audio_project.collaboration.ProjectSyncController;
import com.cmpt276group18.audio_project.service.R2StorageService.PresignedUpload;

/**
 * E5 sample sharing via Cloudflare R2, with no real R2 traffic.
 *
 *  - StorageService: fake credentials. Presigning is a local computation, so
 *    nothing is sent to Cloudflare (no reads or writes counted).
 *  - PresignEndpoint: ProjectService and R2StorageService are Mockito mocks.
 *
 * ASSUMPTIONS TO CHECK AGAINST YOUR CODE:
 *  1. SESSION_USER_KEY matches the attribute ProjectController.currentUser(session) reads.
 *  2. ProjectAccessException / ProjectNotFoundException have a (String) constructor.
 *  3. The controller maps them to 403 / 404.
 */
class R2SampleSharingTest {

    private static final UUID PROJECT_ID = UUID.fromString("11111111-1111-1111-1111-111111111111");
    private static final String SHA = "a".repeat(64);

    // =====================================================================
    // R2StorageService (service layer)
    // =====================================================================
    @Nested
    class StorageService {

        private static final String PUBLIC_URL = "https://samples.example.test";

        private R2StorageService configured() {
            return new R2StorageService("fakeaccount", "FAKEKEYID", "fakesecret", "test-bucket", PUBLIC_URL);
        }

        @Test
        void presign_returnsExpectedObjectKeyAndPublicUrl() {
            PresignedUpload up = configured().createSampleUpload(PROJECT_ID, SHA, "kick.wav", "audio/wav");

            String expectedKey = "projects/" + PROJECT_ID + "/" + SHA + ".wav";
            assertEquals(expectedKey, up.objectKey());
            assertEquals(PUBLIC_URL + "/" + expectedKey, up.publicUrl());
        }

        @Test
        void presign_uploadUrlPointsAtR2BucketAndExpiresInTenMinutes() {
            PresignedUpload up = configured().createSampleUpload(PROJECT_ID, SHA, "kick.wav", "audio/wav");

            assertTrue(up.uploadUrl().startsWith("https://fakeaccount.r2.cloudflarestorage.com/test-bucket/projects/"),
                    "Unexpected upload URL: " + up.uploadUrl());
            assertTrue(up.uploadUrl().contains("X-Amz-Expires=600"), "URL should expire in 600 s");
            assertTrue(up.uploadUrl().contains("X-Amz-Signature="));
        }

        @ParameterizedTest
        @CsvSource({
                "a.wav,wav", "a.mp3,mp3", "a.ogg,ogg", "a.flac,flac", "a.m4a,m4a",
                "LOUD.MP3,mp3", "my.song.final.FLAC,flac"
        })
        void presign_keepsAllowedExtensions(String fileName, String expectedExt) {
            PresignedUpload up = configured().createSampleUpload(PROJECT_ID, SHA, fileName, "audio/mpeg");
            assertTrue(up.objectKey().endsWith("." + expectedExt), up.objectKey());
        }

        @Test
        void presign_stripsTrailingSlashFromPublicBaseUrl() {
            R2StorageService svc = new R2StorageService("fakeaccount", "k", "s", "b", PUBLIC_URL + "/");
            PresignedUpload up = svc.createSampleUpload(PROJECT_ID, SHA, "a.wav", "audio/wav");
            assertEquals(PUBLIC_URL + "/" + up.objectKey(), up.publicUrl());
        }

        @ParameterizedTest
        @NullAndEmptySource
        @ValueSource(strings = { "evil.exe", "noextension", "trailingdot.", "script.sh", "../../etc/passwd" })
        void presign_fallsBackToWavForUnknownExtensions(String fileName) {
            PresignedUpload up = configured().createSampleUpload(PROJECT_ID, SHA, fileName, "audio/wav");
            assertTrue(up.objectKey().endsWith("/" + SHA + ".wav"), up.objectKey());
        }

        @ParameterizedTest
        @NullAndEmptySource
        @ValueSource(strings = {
                "abc",
                "A0000000000000000000000000000000000000000000000000000000000000AB",
                "g000000000000000000000000000000000000000000000000000000000000000",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })
        void presign_rejectsInvalidSha256(String badSha) {
            IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                    () -> configured().createSampleUpload(PROJECT_ID, badSha, "a.wav", "audio/wav"));
            assertEquals("Invalid sample SHA-256 identifier", ex.getMessage());
        }

        @ParameterizedTest
        @NullAndEmptySource
        @ValueSource(strings = { "video/mp4", "text/html", "application/octet-stream", "image/png" })
        void presign_rejectsNonAudioContentTypes(String contentType) {
            IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                    () -> configured().createSampleUpload(PROJECT_ID, SHA, "a.wav", contentType));
            assertEquals("Only audio files are allowed", ex.getMessage());
        }

        @Test
        void presign_throwsWhenCredentialsMissing() {
            R2StorageService svc = new R2StorageService("", "", "", "b", PUBLIC_URL);
            IllegalStateException ex = assertThrows(IllegalStateException.class,
                    () -> svc.createSampleUpload(PROJECT_ID, SHA, "a.wav", "audio/wav"));
            assertTrue(ex.getMessage().contains("not configured"));
        }

        @Test
        void presign_throwsWhenPublicUrlMissing() {
            R2StorageService svc = new R2StorageService("acct", "k", "s", "b", "");
            assertThrows(IllegalStateException.class,
                    () -> svc.createSampleUpload(PROJECT_ID, SHA, "a.wav", "audio/wav"));
        }

        @Test
        void presign_throwsWhenOnlySomeCredentialsPresent() {
            R2StorageService svc = new R2StorageService("acct", "k", "", "b", PUBLIC_URL);
            assertThrows(IllegalStateException.class,
                    () -> svc.createSampleUpload(PROJECT_ID, SHA, "a.wav", "audio/wav"));
        }

        @Test
        void closeIsSafeWhenConfiguredOrNot() {
            new R2StorageService("", "", "", "b", "").close();
            configured().close();
        }
    }

    // =====================================================================
    // POST /api/projects/{id}/samples/presign (controller layer)
    // =====================================================================
    @Nested
    class PresignEndpoint {

        private static final Integer USER_ID = 7;
        private static final String SHA_B = "b".repeat(64);
        private static final String BODY =
                "{\"sha256\":\"" + SHA_B + "\",\"fileName\":\"kick.wav\",\"contentType\":\"audio/wav\"}";

        private ProjectService projectService;
        private R2StorageService r2;
        private MockMvc mvc;

        @BeforeEach
        void setUp() {
            projectService = mock(ProjectService.class);
            r2 = mock(R2StorageService.class);
            mvc = MockMvcBuilders.standaloneSetup(new ProjectController(projectService, r2, mock(ProjectSyncController.class))).build();
        }

        private MockHttpSession loggedIn() {
            MockHttpSession session = new MockHttpSession();
            session.setAttribute(UserManagementController.SESSION_USER_ID, USER_ID);
            return session;
        }

        private MockHttpServletRequestBuilder presign(String body) {
            return post("/api/projects/{id}/samples/presign", PROJECT_ID)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(body);
        }

        @Test
        void editor_getsPresignedUpload() throws Exception {
            when(r2.createSampleUpload(PROJECT_ID, SHA_B, "kick.wav", "audio/wav"))
                    .thenReturn(new PresignedUpload("https://fake-upload.test/put", "https://fake-public.test/k", "projects/k"));

            mvc.perform(presign(BODY).session(loggedIn()))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.uploadUrl").value("https://fake-upload.test/put"))
                    .andExpect(jsonPath("$.publicUrl").value("https://fake-public.test/k"))
                    .andExpect(jsonPath("$.objectKey").value("projects/k"));

            // Permission must be checked before any URL is issued.
            InOrder order = inOrder(projectService, r2);
            order.verify(projectService).assertEditor(PROJECT_ID, USER_ID);
            order.verify(r2).createSampleUpload(PROJECT_ID, SHA_B, "kick.wav", "audio/wav");
        }

        @Test
        void noSession_returns401_andNothingIsCalled() throws Exception {
            mvc.perform(presign(BODY))
                    .andExpect(status().isUnauthorized());

            verifyNoInteractions(projectService, r2);
        }

        @Test
        void viewer_isRejected_andNoUrlIssued() throws Exception {
            doThrow(new ProjectAccessException("Editor access required"))
                    .when(projectService).assertEditor(PROJECT_ID, USER_ID);

            mvc.perform(presign(BODY).session(loggedIn()))
                    .andExpect(status().isForbidden());

            verifyNoInteractions(r2);
        }

        @Test
        void nonexistentProject_returns404_andNoUrlIssued() throws Exception {
            doThrow(new ProjectNotFoundException("Project not found"))
                    .when(projectService).assertEditor(PROJECT_ID, USER_ID);

            mvc.perform(presign(BODY).session(loggedIn()))
                    .andExpect(status().isNotFound());

            verifyNoInteractions(r2);
        }

        @Test
        void invalidInput_returns400WithMessage() throws Exception {
            when(r2.createSampleUpload(any(), anyString(), anyString(), anyString()))
                    .thenThrow(new IllegalArgumentException("Only audio files are allowed"));

            mvc.perform(presign(BODY).session(loggedIn()))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.error").value("Only audio files are allowed"));
        }

        @Test
        void r2NotConfigured_returns503WithMessage() throws Exception {
            when(r2.createSampleUpload(any(), anyString(), anyString(), anyString()))
                    .thenThrow(new IllegalStateException("Cloudflare R2 storage is not configured on the server"));

            mvc.perform(presign(BODY).session(loggedIn()))
                    .andExpect(status().isServiceUnavailable())
                    .andExpect(jsonPath("$.error").value("Cloudflare R2 storage is not configured on the server"));
        }

        @Test
        void request_fieldsArePassedThroughUnchanged() throws Exception {
            when(r2.createSampleUpload(any(), anyString(), anyString(), anyString()))
                    .thenReturn(new PresignedUpload("u", "p", "k"));

            mvc.perform(presign("{\"sha256\":\"" + SHA_B + "\",\"fileName\":\"evil.exe\",\"contentType\":\"audio/mpeg\"}")
                    .session(loggedIn()))
                    .andExpect(status().isOk());

            // The controller must not sanitize or alter input; the service owns validation.
            verify(r2).createSampleUpload(eq(PROJECT_ID), eq(SHA_B), eq("evil.exe"), eq("audio/mpeg"));
        }
    }
}