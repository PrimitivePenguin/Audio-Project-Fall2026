package com.cmpt276group18.audio_project.controller;

import java.nio.charset.StandardCharsets;
import java.util.Optional;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseBody;

import com.cmpt276group18.audio_project.models.usermanagement.UserInfo;
import com.cmpt276group18.audio_project.service.UserService;

import jakarta.servlet.http.HttpSession;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

// Server side of the UI settings (saves them per user).
//
// Storage lives in UserInfo.uiJson (TEXT column) via UserService.getUi / saveUi,
// which also enforces the size limit so users can't store huge blobs.
@Controller
public class UIController {
    static final int MAX_UI_BYTES = UserService.MAX_UI_BYTES;

    // Only used to check that a body parses as JSON; the JS model validates the contents.
    private static final ObjectMapper JSON = new ObjectMapper();

    private final UserService userService;

    public UIController(UserService userService) {
        this.userService = userService;
    }

    // The logged-in user from the session, or empty
    private Optional<UserInfo> currentUser(HttpSession session) {
        return userService.findById(
                (Integer) session.getAttribute(UserManagementController.SESSION_USER_ID));
    }

    // INPUT:  session (may or may not have SESSION_USER_ID)
    // OUTPUT: "settings" template, with currentUser when logged in
    // ACTION: shows the settings page; logged-out users can still use it (saved locally only)
    @GetMapping("/settings")
    public String showSettings(HttpSession session, Model model) {
        currentUser(session).ifPresent(user -> model.addAttribute("currentUser", user));
        return "settings";
    }

    // INPUT:  session
    // OUTPUT: 200 + saved JSON | 204 nothing saved yet | 401 not logged in
    // ACTION: returns the logged-in user's ui JSON
    @GetMapping("/api/ui")
    @ResponseBody
    public ResponseEntity<String> getUi(HttpSession session) {
        Optional<UserInfo> current = currentUser(session);
        if (current.isEmpty()) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        Optional<String> json = userService.getUi(current.get().getId());
        if (json.isEmpty()) {
            return ResponseEntity.noContent().build();
        }
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_JSON).body(json.get());
    }

    // INPUT:  session; body: ui JSON string from ui_model.js toJSON()
    // OUTPUT: 204 saved | 400 empty / not JSON / too large | 401 not logged in
    // ACTION: saves it on the user (server only checks it is valid JSON and small;
    //         the JS model validates the contents again when it loads)
    @PutMapping("/api/ui")
    @ResponseBody
    public ResponseEntity<String> saveUi(HttpSession session, @RequestBody(required = false) String body) {
        Optional<UserInfo> current = currentUser(session);
        if (current.isEmpty()) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (body == null || body.isBlank()) {
            return ResponseEntity.badRequest().body("No settings sent");
        }
        if (body.getBytes(StandardCharsets.UTF_8).length > MAX_UI_BYTES) {
            return ResponseEntity.badRequest().body("Settings too large (max " + MAX_UI_BYTES + " bytes)");
        }
        try {
            JsonNode root = JSON.readTree(body);
            if (root == null || !root.isObject()) {
                return ResponseEntity.badRequest().body("Settings must be a JSON object");
            }
        } catch (JacksonException e) {
            return ResponseEntity.badRequest().body("Settings are not valid JSON");
        }
        if (!userService.saveUi(current.get().getId(), body)) {
            return ResponseEntity.badRequest().body("Could not save settings");
        }
        return ResponseEntity.noContent().build();
    }
}
