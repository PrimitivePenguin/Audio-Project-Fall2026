package com.cmpt276group18.audio_project.collaboration;

import java.security.Principal;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import org.mockito.Mock;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.messaging.simp.SimpMessagingTemplate;

import com.cmpt276group18.audio_project.models.projects.Project;
import com.cmpt276group18.audio_project.service.ProjectService;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectAccessException;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectVersionConflictException;

@ExtendWith(MockitoExtension.class)
class ProjectSyncControllerTest {

    @Mock
    private SimpMessagingTemplate messagingTemplate;

    @Mock
    private ProjectService projectService;

    private ProjectSyncController controller;

    @BeforeEach
    void setUp() {
        controller = new ProjectSyncController(messagingTemplate, projectService);
    }

    private Principal principalFor(int userId) {
        return () -> String.valueOf(userId);
    }

    private ProjectSyncRequest mockRequest(
            String clientId,
            String type,
            String targetId,
            Long baseRevision,
            String name,
            String snapshot) {
        ProjectSyncRequest req = mock(ProjectSyncRequest.class);
        lenient().when(req.clientId()).thenReturn(clientId);
        lenient().when(req.type()).thenReturn(type);
        lenient().when(req.targetId()).thenReturn(targetId);
        lenient().when(req.baseRevision()).thenReturn(baseRevision);
        lenient().when(req.name()).thenReturn(name);
        lenient().when(req.payload()).thenReturn(null);
        lenient().when(req.snapshot()).thenReturn(snapshot);
        return req;
    }

    private Project mockProject(UUID id, String name, Long version, String projectData) {
        Project project = mock(Project.class);
        lenient().when(project.getId()).thenReturn(id);
        lenient().when(project.getName()).thenReturn(name);
        lenient().when(project.getVersion()).thenReturn(version);
        lenient().when(project.getProjectData()).thenReturn(projectData);
        return project;
    }

    @Test
    void synchronize_rejectsUnauthenticatedUser() {
        UUID projectId = UUID.randomUUID();
        ProjectSyncRequest req = mockRequest("client-1", "NOTES_SYNC", "note-1", 1L, "Song", "{}");

        assertThrows(ProjectAccessException.class,
                () -> controller.synchronize(projectId, req, null));
    }

    @Test
    void synchronize_requestStateSendsPrivateSnapshot() {
        UUID projectId = UUID.randomUUID();
        Project project = mockProject(projectId, "Collab Track", 5L, "{\"notes\":[]}");

        when(projectService.findReadable(projectId, 42)).thenReturn(Optional.of(project));
        when(projectService.displayName(42)).thenReturn("kmos");

        ProjectSyncRequest req = mockRequest("client-1", "REQUEST_STATE", projectId.toString(), null, null, null);

        controller.synchronize(projectId, req, principalFor(42));

        ArgumentCaptor<ProjectSyncEvent> eventCaptor = ArgumentCaptor.forClass(ProjectSyncEvent.class);
        verify(messagingTemplate).convertAndSendToUser(eq("42"), eq("/queue/sync"), eventCaptor.capture());
        verify(messagingTemplate, never()).convertAndSend(any(String.class), any(Object.class));

        ProjectSyncEvent sent = eventCaptor.getValue();
        assertEquals("STATE_SNAPSHOT", sent.type());
        assertEquals(5L, sent.revision());
        assertEquals("{\"notes\":[]}", sent.snapshot());
    }

    @Test
    void synchronize_broadcastsValidMutationToProjectTopic() {
        UUID projectId = UUID.randomUUID();
        String snapshot = "{\"notes\":[{\"id\":\"note-1\"}]}";
        Project updated = mockProject(projectId, "Collab Track", 6L, snapshot);

        when(projectService.applySync(projectId, 42, "Collab Track", snapshot, 5L))
                .thenReturn(updated);
        when(projectService.displayName(42)).thenReturn("kmos");

        ProjectSyncRequest req = mockRequest(
                "client-1", "NOTES_SYNC", "note-1", 5L, "Collab Track", snapshot);

        controller.synchronize(projectId, req, principalFor(42));

        ArgumentCaptor<ProjectSyncEvent> eventCaptor = ArgumentCaptor.forClass(ProjectSyncEvent.class);
        verify(messagingTemplate).convertAndSend(
                eq("/topic/projects/" + projectId), eventCaptor.capture());

        ProjectSyncEvent broadcast = eventCaptor.getValue();
        assertEquals("NOTES_SYNC", broadcast.type());
        assertEquals(6L, broadcast.revision());
        assertEquals("kmos", broadcast.actorUsername());
    }

    @Test
    void synchronize_sendsConflictPrivatelyWhenBaseRevisionIsStale() {
        UUID projectId = UUID.randomUUID();
        String latestSnapshot = "{\"notes\":[{\"id\":\"note-9\"}]}";
        Project latest = mockProject(projectId, "Collab Track", 9L, latestSnapshot);

        when(projectService.applySync(eq(projectId), eq(42), any(), any(), eq(5L)))
                .thenThrow(new ProjectVersionConflictException("Stale revision"));
        when(projectService.findReadable(projectId, 42)).thenReturn(Optional.of(latest));
        when(projectService.displayName(42)).thenReturn("kmos");

        ProjectSyncRequest req = mockRequest("client-1", "NOTES_SYNC", "note-1", 5L, "Collab Track", "{}");

        controller.synchronize(projectId, req, principalFor(42));

        ArgumentCaptor<ProjectSyncEvent> eventCaptor = ArgumentCaptor.forClass(ProjectSyncEvent.class);
        verify(messagingTemplate).convertAndSendToUser(eq("42"), eq("/queue/sync"), eventCaptor.capture());
        verify(messagingTemplate, never()).convertAndSend(any(String.class), any(Object.class));

        ProjectSyncEvent conflict = eventCaptor.getValue();
        assertEquals("CONFLICT", conflict.type());
        assertEquals(9L, conflict.revision());
        assertEquals(latestSnapshot, conflict.snapshot());
    }

    @Test
    void synchronize_rejectsUnsupportedSyncTypeWithPrivateError() {
        UUID projectId = UUID.randomUUID();
        ProjectSyncRequest req = mockRequest("client-1", "DROP_DATABASE", "x", 1L, "Song", "{}");

        controller.synchronize(projectId, req, principalFor(42));

        ArgumentCaptor<ProjectSyncEvent> eventCaptor = ArgumentCaptor.forClass(ProjectSyncEvent.class);
        verify(messagingTemplate).convertAndSendToUser(eq("42"), eq("/queue/sync"), eventCaptor.capture());
        verify(projectService, never()).applySync(any(), any(), any(), any(), any());
        assertEquals("ERROR", eventCaptor.getValue().type());
    }
}