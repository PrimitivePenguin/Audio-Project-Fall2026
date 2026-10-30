package com.cmpt276group18.audio_project.collaboration;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller 
public class ProjectSyncController {
    private final SimpMessagingTemplate messagingTemplate;
    private final Map<String, List<ProjectChange>> projectState = new ConcurrentHashMap<>();

    public ProjectSyncController(SimpMessagingTemplate messagingTemplate) {
        this.messagingTemplate = messagingTemplate;
    }

    @GetMapping("/collaboration-test")
    public String collaborationTest() {
        return "collaboration-test";
    }

    @MessageMapping("/projects/{projectId}/sync")
    public void synchronize(ProjectChange change) {
        String destination = "/topic/projects/" + change.projectId();

        if ("REQUEST_STATE".equals(change.type())) {
            projectState.getOrDefault(change.projectId(), List.of())
                .forEach(savedChange -> messagingTemplate.convertAndSend(destination, savedChange));
            return;
        }

        projectState
            .computeIfAbsent(change.projectId(), ignored -> new CopyOnWriteArrayList<>())
            .add(change);

        messagingTemplate.convertAndSend(destination, change);
    }
}
