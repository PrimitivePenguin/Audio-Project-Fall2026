package com.cmpt276group18.audio_project.collaboration;

import java.security.Principal;
import java.util.Map;

import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;
import org.springframework.web.socket.server.support.DefaultHandshakeHandler;
import org.springframework.web.socket.server.support.HttpSessionHandshakeInterceptor;

import com.cmpt276group18.audio_project.controller.UserManagementController;

@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {
    private final ProjectChannelInterceptor projectChannelInterceptor;

    public WebSocketConfig(ProjectChannelInterceptor projectChannelInterceptor) {
        this.projectChannelInterceptor = projectChannelInterceptor;
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry config) {
        config.enableSimpleBroker("/topic", "/queue");
        config.setApplicationDestinationPrefixes("/app");
        config.setUserDestinationPrefix("/user");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
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
}