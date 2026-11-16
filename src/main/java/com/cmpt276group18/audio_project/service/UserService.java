package com.cmpt276group18.audio_project.service;

import java.nio.charset.StandardCharsets;
import java.util.Optional;
import java.util.List;

import org.springframework.data.domain.Sort;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import com.cmpt276group18.audio_project.models.usermanagement.UserInfo;
import com.cmpt276group18.audio_project.models.usermanagement.UserRepository;
import com.cmpt276group18.audio_project.models.usermanagement.forms.SignUpForm;

@Service // Spring creates one of these and hands it to controllers that ask for it
public class UserService {
    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder = new BCryptPasswordEncoder();

    public UserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    public boolean usernameTaken(String username) {
        return username != null && userRepository.existsByUsername(username);
    }

    public boolean emailTaken(String email) {
        if (email == null || email.isBlank()) return false;
        return userRepository.existsByEmail(email.trim().toLowerCase()); // UserInfo stores emails lowercased
    }

    // Saves a new user. Call the *Taken checks first so the page can show a friendly error.
    public UserInfo register(SignUpForm form) {
        // Store a BCrypt hash, never the plain password
        String hashed = passwordEncoder.encode(form.getPassword());
        UserInfo user = new UserInfo(form.getUsername(), hashed, form.getEmail());
        return userRepository.save(user);
    }

    // checks a typed password against the stored hash
    // never check raw password by itself
    public boolean passwordMatches(String rawPassword, UserInfo user) {
        return passwordEncoder.matches(rawPassword, user.getPassword());
    }

    // LOGIN: Returns if username and password are both right (otherwise empty)
    public Optional<UserInfo> login(String username, String rawPassword) {
        // check if empty
        if (username == null || rawPassword == null) { return Optional.empty(); }
        return userRepository.findByUsername(username.trim()).filter(user -> passwordMatches(rawPassword, user));
    }

    // FindById (via session in id)
    public Optional<UserInfo> findById(Integer id) {
        if (id == null) { return Optional.empty(); }
        return userRepository.findById(id);
    }

    // ADMIN
    
    // Find every user, sort by ID
    public List<UserInfo> findAllUsers() {
        return userRepository.findAll(Sort.by("id"));
    }

    // Change a user's role, set to false if no user with that id
    public boolean changeRole(Integer id, UserInfo.RoleType newRole) {
        Optional<UserInfo> user = findById(id);
        if (user.isEmpty() || newRole == null) { return false; }
        user.get().setRoleType(newRole);
        userRepository.save(user.get());
        return true;
    }

    // UI SETTINGS (settings page, see UIController)

    // Largest ui JSON stored per user, so nobody can fill the database with huge blobs
    public static final int MAX_UI_BYTES = 10_000;

    // Saved ui JSON for this user: empty if there is no such user or nothing was saved yet
    public Optional<String> getUi(Integer userId) {
        return findById(userId).map(UserInfo::getUiJson);
    }

    // Stores the ui JSON on the user. False if the user does not exist or the JSON is too big.
    // (UIController checks it is valid JSON; the JS model validates the contents when it loads.)
    public boolean saveUi(Integer userId, String json) {
        if (json == null || json.getBytes(StandardCharsets.UTF_8).length > MAX_UI_BYTES) { return false; }
        Optional<UserInfo> user = findById(userId);
        if (user.isEmpty()) { return false; }
        user.get().setUiJson(json);
        userRepository.save(user.get());
        return true;
    }
}
