package com.cmpt276group18.audio_project.controller;

import java.util.List;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.cmpt276group18.audio_project.collaboration.ProjectSyncController;
import com.cmpt276group18.audio_project.models.projects.Project;
import com.cmpt276group18.audio_project.models.projects.ProjectCollaborator;
import com.cmpt276group18.audio_project.models.projects.ProjectRole;
import com.cmpt276group18.audio_project.service.ProjectService;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectAccessException;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectNotFoundException;
import com.cmpt276group18.audio_project.service.R2StorageService;

import jakarta.servlet.http.HttpSession;

@RestController
@RequestMapping("/api/projects")
public class ProjectController {
    private static final Logger LOG = LoggerFactory.getLogger(ProjectController.class);
    private final ProjectService projectService;
    private final R2StorageService r2StorageService;

    private final ProjectSyncController sync;

    public ProjectController(ProjectService projectService, R2StorageService r2StorageService, ProjectSyncController sync) {
        this.projectService = projectService;
        this.r2StorageService = r2StorageService;
        this.sync = sync;
    }

    @GetMapping
    public ResponseEntity<?> list(HttpSession session) {
        Integer userId = currentUser(session);
        if (userId == null) return unauthorized();
        return ResponseEntity.ok(projectService.findForUser(userId).stream()
                .map(project -> {
                    ProjectRole role = projectService.roleForUser(project.getId(), userId);
                    Map<String, Object> response = new HashMap<>(Map.of(
                            "id", project.getId(),
                            "name", project.getName(),
                            // "projectData", project.getProjectData(),
                            "createdAt", project.getCreatedAt(),
                            "updatedAt", project.getUpdatedAt(),
                            "version", project.getVersion(),
                            "role", role));
                    if (role != ProjectRole.OWNER) {
                        projectService.sharedBy(project.getId(), userId)
                                .ifPresent(sharedBy -> response.put("sharedBy", sharedBy));
                    }
                    return response;
                })
                .toList());
    }

    @PostMapping
    public ResponseEntity<?> create(@RequestBody ProjectRequest request, HttpSession session) {
        Integer userId = currentUser(session);
        if (userId == null) return unauthorized();
        if (request.name() == null || request.name().isBlank()) {
            return ResponseEntity.badRequest().body(Map.of("error", "Project name is required"));
        }
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(projectService.create(userId, request.name().trim(), request.projectData()));
    }

    @GetMapping("/{projectId}")
    public ResponseEntity<?> get(@PathVariable UUID projectId, HttpSession session) {
        Integer userId = currentUser(session);
        if (userId == null) return unauthorized();
        return projectService.findReadable(projectId, userId)
                .<ResponseEntity<?>>map(project -> ResponseEntity.ok(Map.of(
                        "id", project.getId(),
                        "name", project.getName(),
                        "projectData", project.getProjectData(),
                        "createdAt", project.getCreatedAt(),
                        "updatedAt", project.getUpdatedAt(),
                        "version", project.getVersion(),
                        "role", projectService.roleForUser(projectId, userId))))
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND)
                        .body(Map.of("error", "Project not found")));
    }

    @PutMapping("/{projectId}")
    public ResponseEntity<?> update(@PathVariable UUID projectId,
                                    @RequestBody ProjectRequest request,
                                    @RequestHeader(value = "X-Jukebox-Client", required = false) String clientId,
                                    HttpSession session) {
        Integer userId = currentUser(session);
        if (userId == null) return unauthorized();
        Project updated = projectService.update(projectId, userId, request.name(), request.projectData(), request.version());
        try {
            sync.broadcastRestSave(updated, userId, clientId);
        } catch (RuntimeException notificationFailure) {
            // The database transaction has committed. Peers can fetch the revision on reconnect.
            LOG.warn("Could not broadcast saved project {}", projectId);
        }
        return ResponseEntity.ok(updated);
    }

    @DeleteMapping("/{projectId}")
    public ResponseEntity<?> delete(@PathVariable UUID projectId, HttpSession session) {
        Integer userId = currentUser(session);
        if (userId == null) return unauthorized();
        projectService.delete(projectId, userId);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/{projectId}/collaborators")
    public ResponseEntity<?> collaborators(@PathVariable UUID projectId, HttpSession session) {
        Integer userId = currentUser(session);
        if (userId == null) return unauthorized();
        return ResponseEntity.ok(projectService.collaborators(projectId, userId));
    }

    @PostMapping("/{projectId}/collaborators")
    public ResponseEntity<?> add(@PathVariable UUID projectId,
                                 @RequestBody CollaboratorRequest request,
                                 HttpSession session) {
        Integer userId = currentUser(session);
        if (userId == null) return unauthorized();
        return ResponseEntity.status(HttpStatus.CREATED).body(projectService.addCollaborator(
                projectId, userId, request.usernameOrEmail(), request.role()));
    }

    @PatchMapping("/{projectId}/collaborators/{collaboratorId}")
    public ResponseEntity<?> changeRole(@PathVariable UUID projectId,
                                        @PathVariable Integer collaboratorId,
                                        @RequestBody RoleRequest request,
                                        HttpSession session) {
        Integer userId = currentUser(session);
        if (userId == null) return unauthorized();
        return ResponseEntity.ok(projectService.changeRole(projectId, userId, collaboratorId, request.role()));
    }

    @DeleteMapping("/{projectId}/collaborators/{collaboratorId}")
    public ResponseEntity<?> remove(@PathVariable UUID projectId,
                                    @PathVariable Integer collaboratorId,
                                    HttpSession session) {
        Integer userId = currentUser(session);
        if (userId == null) return unauthorized();
        projectService.removeCollaborator(projectId, userId, collaboratorId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{projectId}/leave")
    public ResponseEntity<?> leave(@PathVariable UUID projectId, HttpSession session) {
        Integer userId = currentUser(session);
        if (userId == null) return unauthorized();
        projectService.leave(projectId, userId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{projectId}/transfer-ownership")
    public ResponseEntity<?> transfer(@PathVariable UUID projectId,
                                      @RequestBody TransferRequest request,
                                      HttpSession session) {
        Integer userId = currentUser(session);
        if (userId == null) return unauthorized();
        projectService.transferOwnership(projectId, userId, request.usernameOrEmail());
        return ResponseEntity.noContent().build();
    }

    private Integer currentUser(HttpSession session) {
        return (Integer) session.getAttribute(UserManagementController.SESSION_USER_ID);
    }

    private ResponseEntity<Map<String, String>> unauthorized() {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(Map.of("error", "Login required"));
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(ProjectAccessException.class)
    public ResponseEntity<Map<String, String>> accessDenied(ProjectAccessException exception) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("error", exception.getMessage()));
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(ProjectNotFoundException.class)
    public ResponseEntity<Map<String, String>> notFound(ProjectNotFoundException exception) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", exception.getMessage()));
    }

    @org.springframework.web.bind.annotation.ExceptionHandler({ProjectService.ProjectVersionConflictException.class, OptimisticLockingFailureException.class})
    public ResponseEntity<Map<String, String>> versionConflict(
            ProjectService.ProjectVersionConflictException exception) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", exception.getMessage()));
    }

    public record ProjectRequest(String name, String projectData, Long version) {}
    public record CollaboratorRequest(String usernameOrEmail, ProjectRole role) {}
    public record RoleRequest(ProjectRole role) {}
    public record TransferRequest(String usernameOrEmail) {}

    // For R2
    @PostMapping("/{projectId}/samples/presign")
    public ResponseEntity<?> presignSampleUpload(@PathVariable UUID projectId,
                                                @RequestBody SamplePresignRequest request,
                                                HttpSession session) {
        Integer userId = currentUser(session);
        if (userId == null) return unauthorized();
        projectService.assertEditor(projectId, userId);
        return ResponseEntity.ok(r2StorageService.createSampleUpload(
                projectId, request.sha256(), request.fileName(), request.contentType()));
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<?> badRequest(IllegalArgumentException exception) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of("error", exception.getMessage()));
    }

    @org.springframework.web.bind.annotation.ExceptionHandler(IllegalStateException.class)
    public ResponseEntity<?> storageUnavailable(IllegalStateException exception) {
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of("error", exception.getMessage()));
    }

    public record SamplePresignRequest(String sha256, String fileName, String contentType) {}
}
