package com.cmpt276group18.audio_project.controller;

import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import com.cmpt276group18.audio_project.service.ProjectService;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectAccessException;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectVersionConflictException;

@ExtendWith(MockitoExtension.class)
class ProjectControllerMockMvcTest {
    private static final UUID PROJECT_ID = UUID.randomUUID();

    @Mock
    private ProjectService projectService;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.standaloneSetup(new ProjectController(projectService)).build();
    }

    @Test
    void listRequiresLogin() throws Exception {
        mockMvc.perform(get("/api/projects"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().json("{\"error\":\"Login required\"}"));

        verifyNoInteractions(projectService);
    }

    @Test
    void updateRequiresLogin() throws Exception {
        mockMvc.perform(put("/api/projects/" + PROJECT_ID)
                        .contentType("application/json")
                        .content("""
                                {"name":"Updated","projectData":"{}","version":0}
                                """))
                .andExpect(status().isUnauthorized())
                .andExpect(content().json("{\"error\":\"Login required\"}"));

        verifyNoInteractions(projectService);
    }

    @Test
    void updateReturnsConflictForStaleVersion() throws Exception {
        when(projectService.update(eq(PROJECT_ID), eq(42), eq("Updated"), eq("{}"), eq(0L)))
                .thenThrow(new ProjectVersionConflictException(
                        "Project is stale; reload it before saving"));

        mockMvc.perform(put("/api/projects/" + PROJECT_ID)
                        .sessionAttr(UserManagementController.SESSION_USER_ID, 42)
                        .contentType("application/json")
                        .content("""
                                {"name":"Updated","projectData":"{}","version":0}
                                """))
                .andExpect(status().isConflict())
                .andExpect(content().json(
                        "{\"error\":\"Project is stale; reload it before saving\"}"));

        verify(projectService).update(PROJECT_ID, 42, "Updated", "{}", 0L);
    }

    @Test
    void updateReturnsForbiddenForAccessErrors() throws Exception {
        when(projectService.update(eq(PROJECT_ID), eq(42), isNull(), isNull(), eq(1L)))
                .thenThrow(new ProjectAccessException("Viewer access is read-only"));

        mockMvc.perform(put("/api/projects/" + PROJECT_ID)
                        .sessionAttr(UserManagementController.SESSION_USER_ID, 42)
                        .contentType("application/json")
                        .content("""
                                {"version":1}
                                """))
                .andExpect(status().isForbidden())
                .andExpect(content().json("{\"error\":\"Viewer access is read-only\"}"));

        verify(projectService).update(PROJECT_ID, 42, null, null, 1L);
    }
}
