package com.cmpt276group18.audio_project.collaboration;

public record ProjectChange(
    String projectId,
    String userId,
    String type,
    String targetId,
    Object payload,
    long timestamp
) {}
