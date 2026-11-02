package com.cmpt276group18.audio_project.controller;

import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.validation.BindingResult;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ModelAttribute;
import org.springframework.web.bind.annotation.PostMapping;

import com.cmpt276group18.audio_project.models.usermanagement.forms.SignUpForm;
import com.cmpt276group18.audio_project.service.UserService;

import jakarta.validation.Valid;

@Controller
// Able to direct data btw models and templates
public class UserManagementController {
    static final String DUPLICATE_USERNAME = "this username is already taken";
    static final String DUPLICATE_EMAIL = "user with this email already exists";

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
}
