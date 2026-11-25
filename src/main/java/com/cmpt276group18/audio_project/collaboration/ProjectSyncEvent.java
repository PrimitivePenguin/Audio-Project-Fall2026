package com.cmpt276group18.audio_project.collaboration;

import java.util.UUID;

public record ProjectSyncEvent(
        UUID projectId,
        Integer actorUserId,
        String actorUsername,
        String clientId,
        String type,
        String targetId,
        Long revision,
        String name,
        Object payload,
        String snapshot,
        String error,
        long timestamp
) {}