package com.cmpt276group18.audio_project.collaboration;

import java.security.Principal;
import java.time.Instant;
import java.util.Set;
import java.util.UUID;

import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.messaging.handler.annotation.DestinationVariable;
import org.springframework.messaging.handler.annotation.MessageExceptionHandler;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.annotation.SendToUser;
import org.springframework.stereotype.Controller;

import com.cmpt276group18.audio_project.models.projects.Project;
import com.cmpt276group18.audio_project.service.ProjectService;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectAccessException;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectNotFoundException;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectVersionConflictException;

@Controller
public class ProjectSyncController {
    private static final Set<String> ALLOWED_MUTATION_TYPES = Set.of(
            "NOTES_SYNC",
            "TRACKS_SYNC",
            "AUDIO_SYNC",
            "SETTINGS_SYNC",
            "INSTRUMENTS_SYNC",
            "FULL_SYNC"
    );

    private final SimpMessagingTemplate messagingTemplate;
    private final ProjectService projectService;

    public ProjectSyncController(SimpMessagingTemplate messagingTemplate, ProjectService projectService) {
        this.messagingTemplate = messagingTemplate;
        this.projectService = projectService;
    }

    @MessageMapping("/projects/{projectId}/sync")
    public void synchronize(@DestinationVariable UUID projectId,
                            ProjectSyncRequest request,
                            Principal principal) {
        if (principal == null) {
            throw new ProjectAccessException("Login required");
        }
        Integer userId = Integer.valueOf(principal.getName());
        String userPrincipal = principal.getName();

        if (request == null || request.type() == null) {
            sendPrivate(userPrincipal, new ProjectSyncEvent(
                    projectId, userId, null, null, "ERROR", null,
                    null, null, null, null, "Invalid sync message", Instant.now().toEpochMilli()));
            return;
        }

        if ("REQUEST_STATE".equals(request.type())) {
            Project project = projectService.findReadable(projectId, userId)
                    .orElseThrow(() -> new ProjectAccessException("You do not have access to this project"));
            sendPrivate(userPrincipal, new ProjectSyncEvent(
                    project.getId(),
                    userId,
                    projectService.displayName(userId),
                    request.clientId(),
                    "STATE_SNAPSHOT",
                    project.getId().toString(),
                    project.getVersion(),
                    project.getName(),
                    null,
                    project.getProjectData(),
                    null,
                    Instant.now().toEpochMilli()));
            return;
        }

        if (!ALLOWED_MUTATION_TYPES.contains(request.type())) {
            sendPrivate(userPrincipal, new ProjectSyncEvent(
                    projectId, userId, null, request.clientId(), "ERROR", request.targetId(),
                    null, null, null, null, "Unsupported change type: " + request.type(),
                    Instant.now().toEpochMilli()));
            return;
        }

        try {
            Project updated = projectService.applySync(
                    projectId,
                    userId,
                    request.name(),
                    request.snapshot(),
                    request.baseRevision());

            broadcast(updated, userId, request.clientId(), request.type(), request.targetId(), request.payload());
        } catch (ProjectVersionConflictException | OptimisticLockingFailureException conflict) {
            Project current = projectService.findReadable(projectId, userId)
                    .orElseThrow(() -> new ProjectNotFoundException("Project not found"));
            sendPrivate(userPrincipal, new ProjectSyncEvent(
                    current.getId(),
                    userId,
                    projectService.displayName(userId),
                    request.clientId(),
                    "CONFLICT",
                    request.targetId(),
                    current.getVersion(),
                    current.getName(),
                    null,
                    current.getProjectData(),
                    conflict.getMessage(),
                    Instant.now().toEpochMilli()));
        } catch (ProjectAccessException | ProjectNotFoundException | IllegalArgumentException denied) {
            sendPrivate(userPrincipal, new ProjectSyncEvent(projectId, userId, null, request.clientId(),
                    "ERROR", request.targetId(), null, null, null, null, denied.getMessage(), Instant.now().toEpochMilli()));
        }
    }

    @MessageExceptionHandler({ProjectAccessException.class, ProjectNotFoundException.class, IllegalArgumentException.class})
    @SendToUser("/queue/sync")
    public ProjectSyncEvent handleSyncException(Exception exception, Principal principal) {
        Integer userId = principal != null ? Integer.valueOf(principal.getName()) : null;
        return new ProjectSyncEvent(
                null, userId, null, null, "ERROR", null,
                null, null, null, null, exception.getMessage(), Instant.now().toEpochMilli());
    }

    public void broadcastRestSave(Project project, Integer userId, String clientId) {
        broadcast(project, userId, clientId, "REST_SYNC", null, null);
    }

    private void broadcast(Project project, Integer userId, String clientId, String type, String targetId, Object payload) {
        messagingTemplate.convertAndSend("/topic/projects/" + project.getId(),
                new ProjectSyncEvent(project.getId(), userId, projectService.displayName(userId), clientId,
                        type, targetId, project.getVersion(), project.getName(), payload,
                        project.getProjectData(), null, Instant.now().toEpochMilli()));
    }

    private void sendPrivate(String userPrincipal, ProjectSyncEvent event) {
        messagingTemplate.convertAndSendToUser(userPrincipal, "/queue/sync", event);
    }
}