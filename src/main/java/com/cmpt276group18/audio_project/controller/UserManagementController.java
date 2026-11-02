package com.cmpt276group18.audio_project.controller;

import java.util.Optional;

import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.validation.BindingResult;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ModelAttribute;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;

import com.cmpt276group18.audio_project.models.usermanagement.UserInfo;
import com.cmpt276group18.audio_project.models.usermanagement.forms.SignUpForm;
import com.cmpt276group18.audio_project.service.UserService;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import jakarta.validation.Valid;

@Controller
// Able to direct data btw models and templates
public class UserManagementController {
    static final String DUPLICATE_USERNAME = "this username is already taken";
    static final String DUPLICATE_EMAIL = "user with this email already exists";
    static final String LOGIN_FAILED = "Invalid username or password";

    // Controllers check SESSION_USER_ID to see who it is
    public static final String SESSION_USER_ID = "userID";

    private final UserService userService;

    public UserManagementController(UserService userService) {
        this.userService = userService;
    }

    @GetMapping("/signup")
    public String showSignup(Model model) {
        model.addAttribute("signupForm", new SignUpForm());
        return "signup";                       // → templates/signup.html
    }

    @PostMapping("/signup")
    // ("signupForm") keeps the name the same as in showSignup, so the page finds it when showing errors
    public String signup(@Valid @ModelAttribute("signupForm") SignUpForm signupForm,
                        BindingResult result) {
        if (userService.usernameTaken(signupForm.getUsername())) {
            result.rejectValue("username", "duplicate", DUPLICATE_USERNAME);
        }
        if (userService.emailTaken(signupForm.getEmail())) {
            result.rejectValue("email", "duplicate", DUPLICATE_EMAIL);
        }
        if (result.hasErrors()) return "signup";   // show page again with errors

        userService.register(signupForm);
        return "redirect:/login";
    }

    // Login
    @GetMapping("/login")
    public String showLogin(HttpSession session, Model modele) {
        // Retrieve user info
        Optional<UserInfo> current = userService.findById((Integer)session.getAttribute(SESSION_USER_ID));
        // Already logged in -> show who + logout button
        current.ifPresent(user -> model.addAttribute("currentUser", user));
        return "login";     // template/login.html
    }

    @PostMapping("/login")
    public String login(@RequestParam(defaultValue = "") String username,
                        @RequestParam(defaultValue = "") String password,
                        HttpServletRequest request,
                        Model model) {
        Optional<UserInfo> user = userService.login(username, password);

        // login error
        if(user.isEmpty()) {
            model.addAttribute("error", LOGIN_FAILED);
            model.addAttribute("username", username); // Refill box so they don't have to retype it
            return "login";
        }

        HttpSession session = request.getSession();
        request.changeSessionId(); //prevent expired session
        session.setAttribute(SESSION_USER_ID, user.get().getId());
        return "redirect";
    }
}
