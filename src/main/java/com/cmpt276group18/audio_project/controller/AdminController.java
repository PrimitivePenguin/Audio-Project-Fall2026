package com.cmpt276group18.audio_project.controller;

import java.util.Optional;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.support.RedirectAttributes;

import com.cmpt276group18.audio_project.models.usermanagement.UserInfo;
import com.cmpt276group18.audio_project.models.usermanagement.UserInfo.RoleType;
import com.cmpt276group18.audio_project.service.UserService;

import jakarta.servlet.http.HttpSession;

@Controller 
// Only admin can use page
public class AdminController {
    static final String CANNOT_CHANGE_OWN_ROLE = "You cannot change your own role";

    private final UserService userService;

    public AdminController(UserService userService) {
        this.userService = userService;
    }

    // Show table with every user with dropdown
    @GetMapping("/admin")
    public String adminPage(HttpSession session, Model model) {
        Optional<UserInfo> admin = loggedInUser(session);
        if (admin.isEmpty()) { 
            return "redirect:/login"; 
        }
        requireAdmin(admin.get());

        model.addAttribute("currentUser", admin.get());
        model.addAttribute("users", userService.findAllUsers());
        model.addAttribute("roles",RoleType.values()); // fill dropwdown

        return "admin";
    }

    @PostMapping("/admin/users/{id}/role")
    public String changeRole(@PathVariable Integer id,
                             @RequestParam RoleType role,
                             HttpSession session,
                             RedirectAttributes redirect) {
        Optional<UserInfo> admin = loggedInUser(session);
        if (admin.isEmpty()) { return "redirect:/login"; }
        requireAdmin(admin.get());

         if (admin.get().getId().equals(id)) {
            // Stops an admin removing their own admin role and locking everyone out
            redirect.addFlashAttribute("error", CANNOT_CHANGE_OWN_ROLE);
        } else if (userService.changeRole(id, role)) {
            redirect.addFlashAttribute("message", "Role updated to " + role);
        } else {
            redirect.addFlashAttribute("error", "User not found");
        }
        return "redirect:/admin";
    }

    // load change from database so role changes apply right away
    private Optional<UserInfo> loggedInUser(HttpSession session) {
        return userService.findById((Integer) session.getAttribute(UserManagementController.SESSION_USER_ID));
    }

    // Logged in but not an admin -> "403 Forbidden"
    private void requireAdmin(UserInfo user) {
        if (user.getRoleType() != RoleType.ADMIN) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Admins only");
        }
    }

}