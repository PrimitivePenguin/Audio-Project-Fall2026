package com.cmpt276group18.audio_project.service;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import static org.mockito.ArgumentMatchers.any;
import org.mockito.Mock;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import org.mockito.junit.jupiter.MockitoExtension;

import com.cmpt276group18.audio_project.models.projects.Project;
import com.cmpt276group18.audio_project.models.projects.ProjectCollaborator;
import com.cmpt276group18.audio_project.models.projects.ProjectCollaboratorRepository;
import com.cmpt276group18.audio_project.models.projects.ProjectRepository;
import com.cmpt276group18.audio_project.models.projects.ProjectRole;
import com.cmpt276group18.audio_project.models.usermanagement.UserRepository;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectAccessException;

@ExtendWith(MockitoExtension.class)
class ProjectServiceTest {

    @Mock
    private ProjectRepository projectRepository;

    @Mock
    private ProjectCollaboratorRepository collaboratorRepository;

    @Mock
    private UserRepository userRepository;

    private ProjectService projectService;

    @BeforeEach
    void setUp() {
        projectService = new ProjectService(projectRepository, collaboratorRepository, userRepository);
    }

    @Test
    void applySync_rejectsViewerBeforeMutatingOrSavingProject() {
        UUID projectId = UUID.randomUUID();
        Integer viewerId = 42;

        Project project = mock(Project.class);
        lenient().when(project.getId()).thenReturn(projectId);
        lenient().when(project.getVersion()).thenReturn(3L);
        lenient().when(project.getProjectData()).thenReturn("{\"notes\":[]}");

        ProjectCollaborator viewer = mock(ProjectCollaborator.class);
        when(viewer.getRole()).thenReturn(ProjectRole.VIEWER);

        when(projectRepository.findById(projectId)).thenReturn(Optional.of(project));
        when(collaboratorRepository.findByProjectIdAndUserId(projectId, viewerId))
                .thenReturn(Optional.of(viewer));

        ProjectAccessException ex = assertThrows(
                ProjectAccessException.class,
                () -> projectService.applySync(
                        projectId,
                        viewerId,
                        "Tampered Name",
                        "{\"notes\":[{\"id\":\"unauthorized\"}]}",
                        3L
                )
        );

        assertEquals("Viewer access is read-only", ex.getMessage());
        verify(project, never()).setName(any());
        verify(project, never()).setProjectData(any());
        verify(projectRepository, never()).saveAndFlush(any());
        verify(projectRepository, never()).save(any());
    }
}