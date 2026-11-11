package com.cmpt276group18.audio_project.controller;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.cmpt276group18.audio_project.models.projects.Project;
import com.cmpt276group18.audio_project.models.projects.ProjectCollaborator;
import com.cmpt276group18.audio_project.models.projects.ProjectRole;
import com.cmpt276group18.audio_project.service.ProjectService;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectAccessException;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectNotFoundException;

import jakarta.servlet.http.HttpSession;

@RestController
@RequestMapping("/api/projects")
public class ProjectController {
    private final ProjectService projectService;

    public ProjectController(ProjectService projectService) {
        this.projectService = projectService;
    }

    @GetMapping
    public ResponseEntity<?> list(HttpSession session) {
        Integer userId = currentUser(session);
        if (userId == null) return unauthorized();
        return ResponseEntity.ok(projectService.findForUser(userId).stream()
                .map(project -> Map.of(
                        "id", project.getId(),
                        "name", project.getName(),
                        "projectData", project.getProjectData(),
                        "createdAt", project.getCreatedAt(),
                        "updatedAt", project.getUpdatedAt(),
                        "role", projectService.roleForUser(project.getId(), userId)))
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
                        "role", projectService.roleForUser(projectId, userId))))
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND)
                        .body(Map.of("error", "Project not found")));
    }

    @PutMapping("/{projectId}")
    public ResponseEntity<?> update(@PathVariable UUID projectId,
                                    @RequestBody ProjectRequest request,
                                    HttpSession session) {
        Integer userId = currentUser(session);
        if (userId == null) return unauthorized();
        return ResponseEntity.ok(projectService.update(projectId, userId, request.name(), request.projectData()));
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

    public record ProjectRequest(String name, String projectData) {}
    public record CollaboratorRequest(String usernameOrEmail, ProjectRole role) {}
    public record RoleRequest(ProjectRole role) {}
    public record TransferRequest(String usernameOrEmail) {}
}
