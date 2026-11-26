package com.cmpt276group18.audio_project.collaboration;

public record ProjectSyncRequest(
        String clientId,
        String type,
        String targetId,
        Long baseRevision,
        String name,
        Object payload,
        String snapshot
) {}