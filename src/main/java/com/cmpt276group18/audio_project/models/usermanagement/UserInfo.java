package com.cmpt276group18.audio_project.models.usermanagement;

import java.time.LocalDateTime;

import jakarta.persistence.*;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

@Entity // Save as datbase
@Table(name = "users")
public class UserInfo {
    public enum RoleType {
        USER,
        ADMIN
    } // Vulnerable to some kind of attack where they change the value?

    @Id // Primary key
    @GeneratedValue(strategy = GenerationType.IDENTITY) // Database picks the id (1, 2, 3, ...)
    private Integer id;

    @Column(unique = true, nullable = false)
    @NotBlank(message = "Username is required")
    @Size(max = 50, message = "Username must be at most 50 characters")
    private String username;

    @NotBlank(message = "Password is required")
    @Size(min = 6, message = "Password must be at least 6 characters")
    private String password;
    


    // @Email checks whether email is format name@domain
    @Email(message = "Email must be a valid address, e.g. name@sfu.ca")
    @Size(max = 100, message = "Email must be at most 100 characters")
    // Each email can only be used once (the controller shows a friendly error before the database would reject it)
    // @NotBlank(message = "Email is required")
    @Column(unique = true)
    private String email;

    @Enumerated(EnumType.STRING) // store "USER" or "ADMIN"
    @Column(nullable = false)
    private RoleType roleType = RoleType.USER;


    // Optional
    @Size(max = 500, message = "Comment must be at most 500 characters")
    @Column(length = 500)
    private String comment;

    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    // Empty constructor: JPA uses this when loading rows, and Spring uses it for forms
    public UserInfo() {}

    // Use for registration
    public UserInfo(String username, String password, String email) {
        this.username = username;
        this.password = password;
        setEmail(email); // run here to trigger trim
    }

    // Runs automatically right before the first save
    @PrePersist
    protected void onCreate() {
        createdAt = LocalDateTime.now();
        updatedAt = createdAt;
    }

    // Runs automatically right before an existing row is updated
    @PreUpdate
    protected void onUpdate() {
        updatedAt = LocalDateTime.now();
    }


    // Setters + Getter pair
    public void setId(Integer id) { this.id = id; }
    public Integer getId() { return id; }


    public void setUsername(String username) { this.username = username; }
    public String getUsername() { return username; }

    public void setPassword(String password) { this.password = password; }
    public String getPassword() { return password; }

    // Trim and lowercase email
    public void setEmail(String email) {
        if (email == null || email.isBlank()) {
            this.email = null;
        } else {
            this.email.trim().toLowerCase();
        }
    }
    public String getEmail() { return email; }

    public RoleType getRoleType() { return roleType; }
    public void setRoleType(RoleType roleType) { this.roleType = roleType; }

    public void setCreatedAt(LocalDateTime createdAt) {
        this.createdAt = createdAt;
    }
    public void setUpdatedAt(LocalDateTime updatedAt) {
        this.updatedAt = updatedAt;
    }
    public LocalDateTime getCreatedAt() {
        return createdAt;
    }

    public LocalDateTime getUpdatedAt() {
        return updatedAt;
    }


    public String getComment() { return comment; }
    public void setComment(String comment) { this.comment = comment; }
}
