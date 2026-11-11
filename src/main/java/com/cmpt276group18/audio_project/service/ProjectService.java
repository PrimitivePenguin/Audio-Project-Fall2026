package com.cmpt276group18.audio_project.service;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.cmpt276group18.audio_project.models.projects.Project;
import com.cmpt276group18.audio_project.models.projects.ProjectCollaborator;
import com.cmpt276group18.audio_project.models.projects.ProjectCollaboratorRepository;
import com.cmpt276group18.audio_project.models.projects.ProjectRepository;
import com.cmpt276group18.audio_project.models.projects.ProjectRole;
import com.cmpt276group18.audio_project.models.usermanagement.UserInfo;
import com.cmpt276group18.audio_project.models.usermanagement.UserRepository;

@Service
public class ProjectService {
    private final ProjectRepository projectRepository;
    private final ProjectCollaboratorRepository collaboratorRepository;
    private final UserRepository userRepository;

    public ProjectService(ProjectRepository projectRepository,
                          ProjectCollaboratorRepository collaboratorRepository,
                          UserRepository userRepository) {
        this.projectRepository = projectRepository;
        this.collaboratorRepository = collaboratorRepository;
        this.userRepository = userRepository;
    }

    @Transactional
    public Project create(Integer ownerId, String name, String projectData) {
        requireUser(ownerId);
        Project project = projectRepository.save(new Project(name, ownerId,
                projectData == null ? "{}" : projectData));
        collaboratorRepository.save(new ProjectCollaborator(project.getId(), ownerId,
                ProjectRole.OWNER, null));
        return project;
    }

    public List<Project> findForUser(Integer userId) {
        return collaboratorRepository.findByUserId(userId).stream()
                .map(collaborator -> projectRepository.findById(collaborator.getProjectId()))
                .flatMap(Optional::stream)
                .toList();
    }

    public ProjectRole roleForUser(UUID projectId, Integer userId) {
        return hasRole(projectId, userId)
                .map(ProjectCollaborator::getRole)
                .orElseThrow(() -> new ProjectAccessException("You do not have access to this project"));
    }

    public Optional<Project> findReadable(UUID projectId, Integer userId) {
        return hasRole(projectId, userId).isPresent()
                ? projectRepository.findById(projectId) : Optional.empty();
    }

    @Transactional
    public Project update(UUID projectId, Integer userId, String name, String projectData) {
        Project project = requireProject(projectId);
        requireEditor(projectId, userId);
        if (name != null) project.setName(name);
        if (projectData != null) project.setProjectData(projectData);
        return projectRepository.save(project);
    }

    @Transactional
    public void delete(UUID projectId, Integer userId) {
        requireOwner(projectId, userId);
        requireProject(projectId);
        collaboratorRepository.deleteAll(collaboratorRepository.findByProjectId(projectId));
        projectRepository.deleteById(projectId);
    }

    public List<ProjectCollaborator> collaborators(UUID projectId, Integer userId) {
        requireReadable(projectId, userId);
        return collaboratorRepository.findByProjectId(projectId);
    }

    @Transactional
    public ProjectCollaborator addCollaborator(UUID projectId, Integer ownerId,
                                               String userIdentifier, ProjectRole role) {
        requireOwner(projectId, ownerId);
        UserInfo user = findUser(userIdentifier);
        Integer userId = user.getId();
        if (role == null || role == ProjectRole.OWNER) {
            throw new ProjectAccessException("New collaborators must be editors or viewers");
        }
        if (collaboratorRepository.existsByProjectIdAndUserId(projectId, userId)) {
            throw new ProjectAccessException("This user is already a collaborator");
        }
        ProjectCollaborator collaborator = new ProjectCollaborator(projectId, userId, role, ownerId);
        return collaboratorRepository.save(collaborator);
    }

    @Transactional
    public ProjectCollaborator changeRole(UUID projectId, Integer ownerId,
                                          Integer userId, ProjectRole role) {
        requireOwner(projectId, ownerId);
        if (role == null || role == ProjectRole.OWNER) {
            throw new ProjectAccessException("Use the ownership transfer endpoint for OWNER");
        }
        ProjectCollaborator collaborator = collaboratorRepository
                .findByProjectIdAndUserId(projectId, userId)
                .orElseThrow(() -> new ProjectNotFoundException("Collaborator not found"));
        collaborator.setRole(role);
        return collaboratorRepository.save(collaborator);
    }

    @Transactional
    public void removeCollaborator(UUID projectId, Integer ownerId, Integer userId) {
        requireOwner(projectId, ownerId);
        ProjectCollaborator collaborator = collaboratorRepository
                .findByProjectIdAndUserId(projectId, userId)
                .orElseThrow(() -> new ProjectNotFoundException("Collaborator not found"));
        if (collaborator.getRole() == ProjectRole.OWNER) {
            throw new ProjectAccessException("A project must always have one owner");
        }
        collaboratorRepository.delete(collaborator);
    }

    @Transactional
    public void leave(UUID projectId, Integer userId) {
        ProjectCollaborator collaborator = collaboratorRepository
                .findByProjectIdAndUserId(projectId, userId)
                .orElseThrow(() -> new ProjectAccessException("You do not have access to this project"));
        if (collaborator.getRole() == ProjectRole.OWNER) {
            throw new ProjectAccessException("The owner cannot leave; transfer ownership first");
        }
        collaboratorRepository.delete(collaborator);
    }

    @Transactional
    public void transferOwnership(UUID projectId, Integer ownerId, String newOwnerIdentifier) {
        requireOwner(projectId, ownerId);
        Integer newOwnerId = findUser(newOwnerIdentifier).getId();
        if (ownerId.equals(newOwnerId)) return;
        ProjectCollaborator currentOwner = collaboratorRepository
                .findByProjectIdAndUserId(projectId, ownerId)
                .orElseThrow(() -> new ProjectAccessException("Project has no owner"));
        ProjectCollaborator newOwner = collaboratorRepository
                .findByProjectIdAndUserId(projectId, newOwnerId)
                .orElse(new ProjectCollaborator(projectId, newOwnerId,
                        ProjectRole.VIEWER, ownerId));
        currentOwner.setRole(ProjectRole.EDITOR);
        newOwner.setRole(ProjectRole.OWNER);
        collaboratorRepository.save(currentOwner);
        collaboratorRepository.save(newOwner);
        Project project = requireProject(projectId);
        project.setOwnerId(newOwnerId);
        projectRepository.save(project);
    }

    private Optional<ProjectCollaborator> hasRole(UUID projectId, Integer userId) {
        return collaboratorRepository.findByProjectIdAndUserId(projectId, userId);
    }

    private void requireReadable(UUID projectId, Integer userId) {
        if (hasRole(projectId, userId).isEmpty()) {
            throw new ProjectAccessException("You do not have access to this project");
        }
    }

    private void requireEditor(UUID projectId, Integer userId) {
        ProjectRole role = hasRole(projectId, userId)
                .map(ProjectCollaborator::getRole)
                .orElseThrow(() -> new ProjectAccessException("You do not have access to this project"));
        if (role == ProjectRole.VIEWER) {
            throw new ProjectAccessException("Viewer access is read-only");
        }
    }

    private void requireOwner(UUID projectId, Integer userId) {
        ProjectCollaborator collaborator = hasRole(projectId, userId)
                .orElseThrow(() -> new ProjectAccessException("You do not have access to this project"));
        if (collaborator.getRole() != ProjectRole.OWNER) {
            throw new ProjectAccessException("Only the project owner can perform this action");
        }
    }

    private Project requireProject(UUID projectId) {
        return projectRepository.findById(projectId)
                .orElseThrow(() -> new ProjectNotFoundException("Project not found"));
    }

    private UserInfo requireUser(Integer userId) {
        return userRepository.findById(userId)
                .orElseThrow(() -> new ProjectNotFoundException("User not found"));
    }

    private UserInfo findUser(String identifier) {
        if (identifier == null || identifier.isBlank()) {
            throw new ProjectNotFoundException("Username or email is required");
        }
        String value = identifier.trim();
        Optional<UserInfo> user = value.contains("@")
                ? userRepository.findByEmail(value.toLowerCase())
                : userRepository.findByUsername(value);
        return user.orElseThrow(() -> new ProjectNotFoundException("No user found with that username or email"));
    }

    public static class ProjectAccessException extends RuntimeException {
        public ProjectAccessException(String message) { super(message); }
    }

    public static class ProjectNotFoundException extends RuntimeException {
        public ProjectNotFoundException(String message) { super(message); }
    }
}
