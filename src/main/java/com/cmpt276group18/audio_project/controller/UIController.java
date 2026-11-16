package com.cmpt276group18.audio_project.controller;

import java.util.Optional;

import org.springframework.http.HttpStatus;
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

// Server side of the UI settings (saves them per user).
//
// Needed elsewhere (not done yet):
//   UserInfo.java:    @Column(columnDefinition = "TEXT") private String uiJson;  + getter/setter
//   UserService.java: getUi(Integer userId) / saveUi(Integer userId, String json)
//                     (save: check JSON size, e.g. <= 10 kB, so users can't store huge blobs)
@Controller
public class UIController {
    static final int MAX_UI_BYTES = 10_000;

    private final UserService userService;

    public UiController(UserService userService) {
        this.userService = userService;
    }

    // INPUT:  session (may or may not have SESSION_USER_ID)
    // OUTPUT: "settings" template, with currentUser when logged in
    // ACTION: shows the settings page; logged-out users can still use it (saved locally only)
    @GetMapping("/settings")
    public String showSettings(HttpSession session, Model model) {
        Optional<UserInfo> current = userService.findById(
                (Integer) session.getAttribute(UserManagementController.SESSION_USER_ID));
        current.ifPresent(user -> model.addAttribute("currentUser", user));
        return "settings";
    }

    // INPUT:  session
    // OUTPUT: 200 + saved JSON | 204 nothing saved yet | 401 not logged in
    // ACTION: returns the logged-in user's ui JSON
    @GetMapping("/api/ui")
    @ResponseBody
    public ResponseEntity<String> getUi(HttpSession session) {
        // TODO: look up user; 401 if none; 204 if uiJson is null; else 200 with JSON
        return ResponseEntity.status(HttpStatus.NOT_IMPLEMENTED).build();
    }

    // INPUT:  session; body: ui JSON string from ui-model.js toJSON()
    // OUTPUT: 204 saved | 400 empty / not JSON / too large | 401 not logged in
    // ACTION: saves it on the user (server only checks it is valid JSON and small;
    //         the JS model validates the contents again when it loads)
    @PutMapping("/api/ui")
    @ResponseBody
    public ResponseEntity<String> saveUi(HttpSession session, @RequestBody(required = false) String body) {
        // TODO
        return ResponseEntity.status(HttpStatus.NOT_IMPLEMENTED).build();
    }
}
