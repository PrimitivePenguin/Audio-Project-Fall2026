package com.cmpt276group18.audio_project.models.usermanagement.forms;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import jakarta.validation.constraints.Pattern;

// What the signup page sends. Kept separate from UserInfo so a user can't
// set fields like id or roleType by adding them to the form.
public class SignUpForm {

    @NotBlank(message = "Username is required")
    @Size(max = 50, message = "Username must be at most 50 characters")
    @Pattern(regexp = "^[^@]+$", message = "Username cannot contain @")
    private String username;

    // Optional, same as UserInfo
    @Email(message = "Email must be a valid address, e.g. name@sfu.ca")
    @Size(max = 100, message = "Email must be at most 100 characters")
    private String email;

    @NotBlank(message = "Password is required")
    @Size(min = 6, message = "Password must be at least 6 characters")
    private String password;

    @NotBlank(message = "Please confirm your password")
    private String confirmPassword;

    // Shown under the confirm box when the two passwords differ
    @AssertTrue(message = "Passwords do not match")
    public boolean isPasswordConfirmed() {
        return password == null || password.equals(confirmPassword);
    }

    public String getUsername() { return username; }
    public void setUsername(String username) { this.username = username == null ? null : username.trim(); }

    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }

    public String getPassword() { return password; }
    public void setPassword(String password) { this.password = password; }

    public String getConfirmPassword() { return confirmPassword; }
    public void setConfirmPassword(String confirmPassword) { this.confirmPassword = confirmPassword; }
}
