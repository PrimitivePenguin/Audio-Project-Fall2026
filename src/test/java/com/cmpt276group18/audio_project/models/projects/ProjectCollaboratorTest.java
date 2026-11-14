package com.cmpt276group18.audio_project.models.projects;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.LocalDateTime;
import java.util.UUID;

import org.junit.jupiter.api.Test;

class ProjectCollaboratorTest {
    @Test
    void constructorSetsCompositeKeyAndRoleFields() {
        UUID projectId = UUID.randomUUID();
        ProjectCollaborator collaborator =
                new ProjectCollaborator(projectId, 12, ProjectRole.EDITOR, 3);

        assertEquals(projectId, collaborator.getProjectId());
        assertEquals(12, collaborator.getUserId());
        assertEquals(ProjectRole.EDITOR, collaborator.getRole());
        assertEquals(3, collaborator.getInvitedBy());
    }

    @Test
    void roleCanBeChanged() {
        ProjectCollaborator collaborator =
                new ProjectCollaborator(UUID.randomUUID(), 12, ProjectRole.VIEWER, 3);

        collaborator.setRole(ProjectRole.OWNER);

        assertEquals(ProjectRole.OWNER, collaborator.getRole());
    }

    @Test
    void onCreateInitializesTimestampsTogether() {
        ProjectCollaborator collaborator =
                new ProjectCollaborator(UUID.randomUUID(), 12, ProjectRole.VIEWER, 3);

        collaborator.onCreate();

        assertNotNull(collaborator.getCreatedAt());
        assertEquals(collaborator.getCreatedAt(), collaborator.getUpdatedAt());
    }

    @Test
    void onUpdateKeepsCreatedAtAndSetsUpdatedAt() {
        ProjectCollaborator collaborator =
                new ProjectCollaborator(UUID.randomUUID(), 12, ProjectRole.VIEWER, 3);
        collaborator.onCreate();
        LocalDateTime created = collaborator.getCreatedAt();

        collaborator.setRole(ProjectRole.EDITOR);
        collaborator.onUpdate();

        assertEquals(created, collaborator.getCreatedAt());
        assertTrue(collaborator.getUpdatedAt().compareTo(created) >= 0);
    }
}
