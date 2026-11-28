package com.cmpt276group18.audio_project.collaboration;

import java.security.Principal;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.stereotype.Component;

import com.cmpt276group18.audio_project.controller.UserManagementController;
import com.cmpt276group18.audio_project.service.ProjectService;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectAccessException;

@Component
public class ProjectChannelInterceptor implements ChannelInterceptor {
    private static final Pattern PROJECT_DEST_PATTERN =
            Pattern.compile("^/(?:topic|app)/projects/([0-9a-fA-F-]{36})(?:/sync)?$");

    private final ProjectService projectService;

    public ProjectChannelInterceptor(ProjectService projectService) {
        this.projectService = projectService;
    }

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (accessor == null || accessor.getCommand() == null) {
            return message;
        }

        StompCommand command = accessor.getCommand();
        if (command == StompCommand.CONNECT) {
            if (resolveUserId(accessor) == null) {
                throw new ProjectAccessException("Login required");
            }
            return message;
        }

        if (command == StompCommand.SUBSCRIBE || command == StompCommand.SEND) {
            Integer userId = resolveUserId(accessor);
            if (userId == null) {
                throw new ProjectAccessException("Login required");
            }
            String destination = accessor.getDestination();
            if (destination != null) {
                Matcher matcher = PROJECT_DEST_PATTERN.matcher(destination);
                if (matcher.matches()) {
                    UUID projectId = UUID.fromString(matcher.group(1));
                    // Throws ProjectAccessException if user is not OWNER, EDITOR, or VIEWER
                    projectService.roleForUser(projectId, userId);
                } else if (destination.startsWith("/topic/projects/") || destination.startsWith("/app/projects/")) {
                    throw new ProjectAccessException("Invalid project destination");
                }
            }
        }
        return message;
    }

    public static Integer resolveUserId(StompHeaderAccessor accessor) {
        Principal principal = accessor.getUser();
        if (principal != null && principal.getName() != null) {
            try {
                return Integer.valueOf(principal.getName());
            } catch (NumberFormatException ignored) {
                // Fall back to session attribute
            }
        }
        Map<String, Object> attrs = accessor.getSessionAttributes();
        if (attrs != null && attrs.get(UserManagementController.SESSION_USER_ID) instanceof Integer id) {
            return id;
        }
        return null;
    }
}