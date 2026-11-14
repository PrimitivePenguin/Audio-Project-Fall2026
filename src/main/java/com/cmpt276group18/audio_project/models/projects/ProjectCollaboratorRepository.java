package com.cmpt276group18.audio_project.models.projects;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

public interface ProjectCollaboratorRepository extends JpaRepository<ProjectCollaborator, ProjectCollaboratorId> {
    List<ProjectCollaborator> findByUserId(Integer userId);
    List<ProjectCollaborator> findByProjectId(UUID projectId);
    Optional<ProjectCollaborator> findByProjectIdAndUserId(UUID projectId, Integer userId);
    boolean existsByProjectIdAndUserId(UUID projectId, Integer userId);
}
