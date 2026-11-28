package com.cmpt276group18.audio_project.collaboration;

import java.security.Principal;
import java.util.Map;
import java.util.UUID;

import org.springframework.beans.factory.ObjectProvider;

import org.springframework.context.annotation.Configuration;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.user.SimpUserRegistry;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketTransportRegistration;
import org.springframework.web.socket.server.support.DefaultHandshakeHandler;
import org.springframework.web.socket.server.support.HttpSessionHandshakeInterceptor;

import com.cmpt276group18.audio_project.controller.UserManagementController;
import com.cmpt276group18.audio_project.service.ProjectService;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectAccessException;

import org.springframework.context.annotation.Bean;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;



@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {
    private final ProjectChannelInterceptor projectChannelInterceptor;

    private final ObjectProvider<SimpUserRegistry> users;
    private final ProjectService projects;

    public WebSocketConfig(ProjectChannelInterceptor projectChannelInterceptor,
                           ObjectProvider<SimpUserRegistry> users, ProjectService projects) {
        this.projectChannelInterceptor = projectChannelInterceptor;
        this.users = users;
        this.projects = projects;
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry config) {
        config.enableSimpleBroker("/topic", "/queue");
        config.setApplicationDestinationPrefixes("/app");
        config.setUserDestinationPrefix("/user");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        // Spring defaults to same-origin requests. Forwarded headers preserve the
        // public HTTPS origin when Render terminates TLS before the servlet.
        registry.addEndpoint("/ws")
                .addInterceptors(new HttpSessionHandshakeInterceptor() {
                    @Override
                    public boolean beforeHandshake(ServerHttpRequest request,
                                                   ServerHttpResponse response,
                                                   WebSocketHandler wsHandler,
                                                   Map<String, Object> attributes) throws Exception {
                        boolean allowed = super.beforeHandshake(request, response, wsHandler, attributes);
                        if (!allowed || attributes.get(UserManagementController.SESSION_USER_ID) == null) {
                            response.setStatusCode(HttpStatus.UNAUTHORIZED);
                            return false;
                        }
                        return true;
                    }
                })
                .setHandshakeHandler(new DefaultHandshakeHandler() {
                    @Override
                    protected Principal determineUser(ServerHttpRequest request,
                                                      WebSocketHandler wsHandler,
                                                      Map<String, Object> attributes) {
                        Object userId = attributes.get(UserManagementController.SESSION_USER_ID);
                        return userId != null ? userId::toString : null;
                    }
                });
    }

    @Override
    public void configureClientInboundChannel(ChannelRegistration registration) {
        registration.interceptors(projectChannelInterceptor);
    }

    @Override
    public void configureClientOutboundChannel(ChannelRegistration registration) {
        registration.interceptors(new ChannelInterceptor() {
            @Override
            public Message<?> preSend(Message<?> message, MessageChannel channel) {
                String destination = SimpMessageHeaderAccessor.getDestination(message.getHeaders());
                if (destination == null || !destination.startsWith("/topic/projects/")) return message;
                String sessionId = SimpMessageHeaderAccessor.getSessionId(message.getHeaders());
                // Recheck the actual recipient even if its subscription predates revocation.
                try {
                    UUID projectId = UUID.fromString(destination.substring("/topic/projects/".length()));
                    var user = users.getObject().getUsers().stream()
                            .filter(candidate -> candidate.getSession(sessionId) != null)
                            .findFirst().orElse(null);
                    if (user == null) return null;
                    projects.roleForUser(projectId, Integer.valueOf(user.getName()));
                    return message;
                } catch (IllegalArgumentException | ProjectAccessException | DataAccessException denied) {
                    return null;
                }
            }
        });
    }

    @Override
    public void configureWebSocketTransport(WebSocketTransportRegistration registry) {
        registry.setMessageSizeLimit(2 * 1024 * 1024);      // 2 MB max incoming STOMP frame
        registry.setSendBufferSizeLimit(4 * 1024 * 1024);   // 4 MB outbound buffer
        registry.setSendTimeLimit(20 * 1000);               // 20s send timeout
    }

    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(2 * 1024 * 1024);
        container.setMaxBinaryMessageBufferSize(2 * 1024 * 1024);
        return container;
    }
}
