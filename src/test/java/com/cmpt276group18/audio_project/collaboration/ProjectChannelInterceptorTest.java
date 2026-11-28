package com.cmpt276group18.audio_project.collaboration;

import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.messaging.Message;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;

import com.cmpt276group18.audio_project.models.projects.ProjectRole;
import com.cmpt276group18.audio_project.service.ProjectService;
import com.cmpt276group18.audio_project.service.ProjectService.ProjectAccessException;

import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ProjectChannelInterceptorTest {
    private static final String PROJECT_ID = "12345678-1234-1234-1234-123456789abc";
    private static final UUID PROJECT = UUID.fromString(PROJECT_ID);
    private static final String TOPIC = "/topic/projects/" + PROJECT_ID;
    private static final String SYNC = "/app/projects/" + PROJECT_ID + "/sync";
    private final ProjectService projects = mock(ProjectService.class);
    private final ProjectChannelInterceptor interceptor = new ProjectChannelInterceptor(projects);

    @ParameterizedTest
    @ValueSource(strings = {TOPIC, "/topic/unrelated", "/queue/sync", "/user/queue/sync",
            "/app/projects/*/sync", SYNC + "/extra", "/app/unrelated"})
    void clientCannotPublishToServerDestinationsOrOtherHandlers(String destination) {
        Message<byte[]> frame = frame(StompCommand.SEND, destination, 42);
        assertThrows(ProjectAccessException.class, () -> interceptor.preSend(frame, null));
        verifyNoInteractions(projects);
    }

    @ParameterizedTest
    @ValueSource(strings = {"/topic/projects/*", TOPIC + "/sync", SYNC, "/queue/sync",
            "/user/99/queue/sync"})
    void subscriptionsMustAddressAnExactProjectOrTheSessionPrivateQueue(String destination) {
        Message<byte[]> frame = frame(StompCommand.SUBSCRIBE, destination, 42);
        assertThrows(ProjectAccessException.class, () -> interceptor.preSend(frame, null));
        verifyNoInteractions(projects);
    }

    @Test
    void authenticatedCollaboratorsCanAddressTheirProject() {
        when(projects.roleForUser(PROJECT, 42)).thenReturn(ProjectRole.EDITOR);
        when(projects.roleForUser(PROJECT, 43)).thenReturn(ProjectRole.VIEWER);
        accepts(StompCommand.SUBSCRIBE, TOPIC, 42);
        accepts(StompCommand.SUBSCRIBE, TOPIC, 43);
        accepts(StompCommand.SUBSCRIBE, "/user/queue/sync", 43);
        accepts(StompCommand.SEND, SYNC, 42);
        // Viewer state requests use the same handler as editor updates.
        accepts(StompCommand.SEND, SYNC, 43);
    }

    @Test
    void missingIdentityAndNonmembersAreDenied() {
        when(projects.roleForUser(PROJECT, 99)).thenThrow(new ProjectAccessException("No access"));
        assertThrows(ProjectAccessException.class,
                () -> interceptor.preSend(frame(StompCommand.SUBSCRIBE, TOPIC, 99), null));
        assertThrows(ProjectAccessException.class,
                () -> interceptor.preSend(frame(StompCommand.SEND, SYNC, 99), null));
        assertThrows(ProjectAccessException.class,
                () -> interceptor.preSend(frame(StompCommand.SUBSCRIBE, "/user/queue/sync", null), null));
        assertThrows(ProjectAccessException.class,
                () -> interceptor.preSend(frame(StompCommand.SEND, SYNC, null), null));
        assertThrows(ProjectAccessException.class,
                () -> interceptor.preSend(frame(StompCommand.CONNECT, null, null), null));
    }

    private void accepts(StompCommand command, String destination, int userId) {
        Message<byte[]> frame = frame(command, destination, userId);
        assertSame(frame, interceptor.preSend(frame, null));
    }

    private static Message<byte[]> frame(StompCommand command, String destination, Integer userId) {
        StompHeaderAccessor headers = StompHeaderAccessor.create(command);
        if (destination != null) headers.setDestination(destination);
        if (userId != null) headers.setUser(userId::toString);
        return MessageBuilder.createMessage(new byte[0], headers.getMessageHeaders());
    }
}
