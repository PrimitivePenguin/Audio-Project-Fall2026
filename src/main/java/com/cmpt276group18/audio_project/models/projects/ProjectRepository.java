package com.cmpt276group18.audio_project.models.projects;

import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

public interface ProjectRepository extends JpaRepository<Project, UUID> {
    List<Project> findDistinctByIdIn(List<UUID> ids);
}
