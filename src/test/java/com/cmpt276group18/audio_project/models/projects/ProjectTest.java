package com.cmpt276group18.audio_project.models.projects;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.LocalDateTime;
import java.util.UUID;

import org.junit.jupiter.api.Test;

class ProjectTest {
    @Test
    void constructorSetsProjectFields() {
        Project project = new Project("My song", 7, "{\"notes\":[]}");

        assertEquals("My song", project.getName());
        assertEquals(7, project.getOwnerId());
        assertEquals("{\"notes\":[]}", project.getProjectData());
        assertNull(project.getId());
        assertNull(project.getVersion());
    }

    @Test
    void settersUpdateProjectFields() {
        Project project = new Project("Old name", 7, "{}");

        project.setName("New name");
        project.setOwnerId(9);
        project.setProjectData("{\"stepCount\":32}");

        assertEquals("New name", project.getName());
        assertEquals(9, project.getOwnerId());
        assertEquals("{\"stepCount\":32}", project.getProjectData());
    }

    @Test
    void onCreateInitializesTimestampsTogether() {
        Project project = new Project("My song", 7, "{}");

        project.onCreate();

        assertNotNull(project.getCreatedAt());
        assertEquals(project.getCreatedAt(), project.getUpdatedAt());
    }

    @Test
    void onUpdatePreservesCreatedAtAndRefreshesUpdatedAt() {
        Project project = new Project("My song", 7, "{}");
        project.onCreate();
        project.setName("Renamed");
        project.onUpdate();

        assertNotNull(project.getCreatedAt());
        assertTrue(project.getUpdatedAt().compareTo(project.getCreatedAt()) >= 0);
    }
}
