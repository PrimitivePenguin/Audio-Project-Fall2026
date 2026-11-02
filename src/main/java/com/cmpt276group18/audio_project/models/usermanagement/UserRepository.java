package com.cmpt276group18.audio_project.models.usermanagement;

import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;

public interface UserRepository extends JpaRepository<UserInfo, Integer> {
    Optional<UserInfo> findByUsername(String username);
    boolean existsByUsername(String username);
    boolean existsByEmail(String email);
}