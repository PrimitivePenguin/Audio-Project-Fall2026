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
    private static final String PROJECT_ID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
    private static final Pattern PROJECT_SUBSCRIPTION = Pattern.compile("/topic/projects/" + PROJECT_ID);
    private static final Pattern PROJECT_SEND = Pattern.compile("/app/projects/" + PROJECT_ID + "/sync");
    private static final String PRIVATE_SUBSCRIPTION = "/user/queue/sync";

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
        if (command == StompCommand.CONNECT || command == StompCommand.STOMP) {
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
            if (command == StompCommand.SUBSCRIBE && PRIVATE_SUBSCRIPTION.equals(destination)) {
                return message;
            }
            Pattern allowed = command == StompCommand.SUBSCRIBE ? PROJECT_SUBSCRIPTION : PROJECT_SEND;
            if (destination == null) {
                throw new ProjectAccessException("STOMP destination is required");
            }
            Matcher matcher = allowed.matcher(destination);
            if (!matcher.matches()) {
                throw new ProjectAccessException("STOMP destination is not allowed");
            }
            // The sync endpoint also serves REQUEST_STATE. The controller and service
            // enforce read or edit permission according to the request type.
            projectService.roleForUser(UUID.fromString(matcher.group(1)), userId);
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
