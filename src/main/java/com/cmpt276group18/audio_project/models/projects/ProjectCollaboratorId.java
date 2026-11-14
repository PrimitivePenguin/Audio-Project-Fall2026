package com.cmpt276group18.audio_project.models.projects;

import java.io.Serializable;
import java.util.UUID;

public class ProjectCollaboratorId implements Serializable {
    private UUID projectId;
    private Integer userId;

    public ProjectCollaboratorId() {
    }

    public ProjectCollaboratorId(UUID projectId, Integer userId) {
        this.projectId = projectId;
        this.userId = userId;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof ProjectCollaboratorId that)) return false;
        return java.util.Objects.equals(projectId, that.projectId)
                && java.util.Objects.equals(userId, that.userId);
    }

    @Override
    public int hashCode() {
        return java.util.Objects.hash(projectId, userId);
    }
}
