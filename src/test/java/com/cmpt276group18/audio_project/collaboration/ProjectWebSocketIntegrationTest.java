package com.cmpt276group18.audio_project.collaboration;

import java.lang.reflect.Type;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.UUID;
import java.util.Optional;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import jakarta.servlet.http.HttpSession;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.tomcat.autoconfigure.servlet.TomcatServletWebServerAutoConfiguration;
import org.springframework.boot.webmvc.autoconfigure.DispatcherServletAutoConfiguration;
import org.springframework.boot.webmvc.autoconfigure.WebMvcAutoConfiguration;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.messaging.converter.JacksonJsonMessageConverter;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.SimpMessageType;
import org.springframework.messaging.simp.broker.SimpleBrokerMessageHandler;
import org.springframework.messaging.simp.stomp.StompFrameHandler;
import org.springframework.messaging.simp.stomp.StompHeaders;
import org.springframework.messaging.simp.stomp.StompSession;
import org.springframework.messaging.simp.stomp.StompSessionHandlerAdapter;
import org.springframework.messaging.simp.user.UserDestinationResolver;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.messaging.WebSocketStompClient;

import com.cmpt276group18.audio_project.controller.UserManagementController;
import com.cmpt276group18.audio_project.models.projects.Project;
import com.cmpt276group18.audio_project.models.projects.ProjectCollaborator;
import com.cmpt276group18.audio_project.models.projects.ProjectCollaboratorRepository;
import com.cmpt276group18.audio_project.models.projects.ProjectRepository;
import com.cmpt276group18.audio_project.models.projects.ProjectRole;
import com.cmpt276group18.audio_project.models.usermanagement.UserRepository;
import com.cmpt276group18.audio_project.service.ProjectService;

import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SpringBootTest(classes = ProjectWebSocketIntegrationTest.Server.class,
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"server.address=127.0.0.1", "server.forward-headers-strategy=framework",
                "spring.config.location=optional:classpath:/websocket-test.properties"})
class ProjectWebSocketIntegrationTest {
    @Configuration(proxyBeanMethods = false)
    @ImportAutoConfiguration({TomcatServletWebServerAutoConfiguration.class,
            DispatcherServletAutoConfiguration.class, WebMvcAutoConfiguration.class})
    @Import({WebSocketConfig.class, ProjectChannelInterceptor.class, ProjectSyncController.class,
            ProjectService.class, TestSessions.class})
    static class Server {}

    @RestController
    static class TestSessions {
        @GetMapping("/test-session/{user}")
        String create(@PathVariable int user, HttpSession session) {
            session.setAttribute(UserManagementController.SESSION_USER_ID, user);
            return "test session";
        }
    }

    @LocalServerPort int port;
    @MockitoBean ProjectRepository projects;
    @MockitoBean ProjectCollaboratorRepository collaborators;
    @MockitoBean UserRepository users;
    @Autowired SimpleBrokerMessageHandler broker;
    @Autowired UserDestinationResolver userDestinations;
    @Autowired ProjectSyncController syncController;

    @Test
    void editorUpdatesReachViewerAndViewerCanOnlyRequestState() throws Exception {
        Project project = new Project("Song", 42, "{}");
        UUID id = UUID.randomUUID();
        ReflectionTestUtils.setField(project, "id", id);
        ReflectionTestUtils.setField(project, "version", 1L);
        when(projects.findById(id)).thenReturn(Optional.of(project));
        when(collaborators.findByProjectIdAndUserId(id, 42))
                .thenReturn(Optional.of(new ProjectCollaborator(id, 42, ProjectRole.EDITOR, null)));
        when(collaborators.findByProjectIdAndUserId(id, 43))
                .thenReturn(Optional.of(new ProjectCollaborator(id, 43, ProjectRole.VIEWER, null)));
        when(collaborators.findByProjectIdAndUserId(id, 44))
                .thenReturn(Optional.of(new ProjectCollaborator(id, 44, ProjectRole.EDITOR, null)));
        when(projects.saveAndFlush(project)).thenAnswer(invocation -> {
            ReflectionTestUtils.setField(project, "version", project.getVersion() + 1);
            return project;
        });

        var client = newClient();
        try {
            StompSession editor = connect(client, sessionCookie(42), localOrigin(), null);
            StompSession viewer = connect(client, sessionCookie(43), localOrigin(), null);
            StompSession secondEditor = connect(client, sessionCookie(44), localOrigin(), null);
            var viewerReplies = new EventQueue();
            var updates = new EventQueue();
            viewer.subscribe("/user/queue/sync", viewerReplies);
            String topic = "/topic/projects/" + id;
            viewer.subscribe(topic, updates);
            var editorUpdates = new EventQueue();
            var secondEditorUpdates = new EventQueue();
            editor.subscribe(topic, editorUpdates);
            secondEditor.subscribe(topic, secondEditorUpdates);
            // The simple broker does not send subscription receipts. Wait until both
            // subscriptions are registered before publishing requests and updates.
            await().atMost(Duration.ofSeconds(5)).until(() ->
                    broker.getSubscriptionRegistry().findSubscriptions(messageFor(topic)).size() == 3 && hasPrivateSubscription(43));

            String sync = "/app/projects/" + id + "/sync";
            viewer.send(sync, new ProjectSyncRequest("viewer", "REQUEST_STATE",
                    null, null, null, null, null));
            assertEquals("STATE_SNAPSHOT", viewerReplies.next().type());

            editor.send(sync, new ProjectSyncRequest("editor", "NOTES_SYNC",
                    "note-1", 1L, "Song", null, "{\"notes\":[]}"));
            ProjectSyncEvent event = updates.next();
            assertEquals("NOTES_SYNC", event.type());
            assertEquals(2L, event.revision());
            assertEquals("{\"notes\":[]}", event.snapshot());

            viewer.send(sync, new ProjectSyncRequest("viewer", "NOTES_SYNC",
                    "note-2", 2L, "Song", null, "{}"));
            ProjectSyncEvent rejection = viewerReplies.next();
            assertEquals("ERROR", rejection.type());
            assertEquals("Viewer access is read-only", rejection.error());
            verify(projects, times(1)).saveAndFlush(project);
            assertEquals(2L, editorUpdates.next().revision());
            assertEquals(2L, secondEditorUpdates.next().revision());

            when(collaborators.findByProjectIdAndUserId(id, 43)).thenReturn(Optional.empty());
            secondEditor.send(sync, new ProjectSyncRequest("editor-2", "NOTES_SYNC",
                    "note-3", 2L, "Song", null, "{\"notes\":[3]}"));
            assertEquals(3L, editorUpdates.next().revision());
            assertEquals(3L, secondEditorUpdates.next().revision());

            syncController.broadcastRestSave(project, 42, "rest-client");
            assertEquals("REST_SYNC", editorUpdates.next().type());
            assertEquals("REST_SYNC", secondEditorUpdates.next().type());
            assertEquals(null, updates.events.poll(300, TimeUnit.MILLISECONDS));
            verify(projects, times(2)).saveAndFlush(project);
            secondEditor.disconnect();
            viewer.disconnect();
            editor.disconnect();
        } finally {
            client.stop();
        }
    }

    @Test
    void handshakeRequiresSessionAndSameOriginIncludingForwardedHttps() throws Exception {
        var client = newClient();
        try {
            String cookie = sessionCookie(42);
            assertThrows(ExecutionException.class,
                    () -> connect(client, null, localOrigin(), null));
            assertThrows(ExecutionException.class,
                    () -> connect(client, cookie, "https://unrelated.example", null));
            StompSession forwarded = connect(client, cookie, "https://jukebox.example",
                    "proto=https;host=jukebox.example");
            assertTrue(forwarded.isConnected());
            forwarded.disconnect();
            StompSession reconnected = connect(client, cookie, "https://jukebox.example",
                    "proto=https;host=jukebox.example");
            assertTrue(reconnected.isConnected());
            reconnected.disconnect();
        } finally {
            client.stop();
        }
    }

    private WebSocketStompClient newClient() {
        var client = new WebSocketStompClient(new StandardWebSocketClient());
        client.setMessageConverter(new JacksonJsonMessageConverter());
        return client;
    }

    private StompSession connect(WebSocketStompClient client, String cookie, String origin,
                                 String forwarded) throws Exception {
        var headers = new WebSocketHttpHeaders();
        headers.setOrigin(origin);
        if (cookie != null) headers.add("Cookie", cookie);
        if (forwarded != null) headers.add("Forwarded", forwarded);
        return client.connectAsync("ws://127.0.0.1:" + port + "/ws", headers,
                new StompSessionHandlerAdapter() {}).get(5, TimeUnit.SECONDS);
    }

    private String localOrigin() {
        return "http://127.0.0.1:" + port;
    }

    private String sessionCookie(int user) throws Exception {
        var request = HttpRequest.newBuilder(URI.create(localOrigin() + "/test-session/" + user)).build();
        var response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.discarding());
        assertEquals(200, response.statusCode());
        return response.headers().firstValue("Set-Cookie").orElseThrow().split(";", 2)[0];
    }

    private boolean hasSubscription(String destination) {
        return !broker.getSubscriptionRegistry().findSubscriptions(messageFor(destination)).isEmpty();
    }

    private boolean hasPrivateSubscription(int user) {
        var resolved = userDestinations.resolveDestination(messageFor("/user/" + user + "/queue/sync"));
        return resolved != null && resolved.getTargetDestinations().stream().anyMatch(this::hasSubscription);
    }

    private static org.springframework.messaging.Message<byte[]> messageFor(String destination) {
        var headers = SimpMessageHeaderAccessor.create(SimpMessageType.MESSAGE);
        headers.setDestination(destination);
        return MessageBuilder.createMessage(new byte[0], headers.getMessageHeaders());
    }

    private static class EventQueue implements StompFrameHandler {
        private final LinkedBlockingQueue<ProjectSyncEvent> events = new LinkedBlockingQueue<>();

        @Override
        public Type getPayloadType(StompHeaders headers) {
            return ProjectSyncEvent.class;
        }

        @Override
        public void handleFrame(StompHeaders headers, Object payload) {
            events.add((ProjectSyncEvent) payload);
        }

        ProjectSyncEvent next() throws InterruptedException {
            ProjectSyncEvent event = events.poll(5, TimeUnit.SECONDS);
            assertNotNull(event, "Expected a collaboration event");
            return event;
        }
    }
}
