package com.cmpt276group18.audio_project.collaboration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.SimpMessagingTemplate;

class ProjectSyncControllerTest {
    private static final String PROJECT_ID = "demo-project";
    private static final String NOTE_ID = "note-1";
    private static final String DESTINATION = "/topic/projects/" + PROJECT_ID;

    @Test
    void concurrentEditsToTheSameNoteAreAllStoredAndBroadcast() throws Exception {
        SimpMessagingTemplate messagingTemplate = mock(SimpMessagingTemplate.class);
        ProjectSyncController controller = new ProjectSyncController(messagingTemplate);
        int editsPerUser = 100;
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);

        try (ExecutorService executor = Executors.newFixedThreadPool(2)) {
            executor.submit(() -> sendEdits(controller, "user-a", editsPerUser, ready, start));
            executor.submit(() -> sendEdits(controller, "user-b", editsPerUser, ready, start));

            assertTrue(ready.await(5, TimeUnit.SECONDS));
            start.countDown();
            executor.shutdown();
            assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS));
        }

        int totalEdits = editsPerUser * 2;
        verify(messagingTemplate, timeout(1000).times(totalEdits))
            .convertAndSend(eq(DESTINATION), any(ProjectChange.class));

        controller.synchronize(PROJECT_ID, new ProjectChange(
            PROJECT_ID, "observer", "REQUEST_STATE", "", null, System.currentTimeMillis()));

        verify(messagingTemplate, timeout(1000).times(totalEdits * 2))
            .convertAndSend(eq(DESTINATION), any(ProjectChange.class));
    }

    @Test
    void replayKeepsConcurrentEditsForTheSameNoteInArrivalOrder() {
        SimpMessagingTemplate messagingTemplate = mock(SimpMessagingTemplate.class);
        ProjectSyncController controller = new ProjectSyncController(messagingTemplate);
        ProjectChange first = change("user-a", 1, 60);
        ProjectChange second = change("user-b", 2, 72);

        controller.synchronize(PROJECT_ID, first);
        controller.synchronize(PROJECT_ID, second);
        controller.synchronize(PROJECT_ID, new ProjectChange(
            PROJECT_ID, "observer", "REQUEST_STATE", "", null, 3));

        var changes = new ArrayList<ProjectChange>();
        var captor = org.mockito.ArgumentCaptor.forClass(ProjectChange.class);
        verify(messagingTemplate, org.mockito.Mockito.times(4))
            .convertAndSend(eq(DESTINATION), captor.capture());
        changes.addAll(captor.getAllValues());

        assertEquals(List.of(first, second, first, second), changes);
        assertTrue(changes.stream().allMatch(change -> NOTE_ID.equals(change.targetId())));
    }

    @Test
    void simultaneousSessionsEditingTheSameNoteProduceAnObservableConflict() {
        SimpMessagingTemplate messagingTemplate = mock(SimpMessagingTemplate.class);
        ProjectSyncController controller = new ProjectSyncController(messagingTemplate);
        ProjectChange sessionA = change("session-a", 10, 64);
        ProjectChange sessionB = change("session-b", 11, 67);

        controller.synchronize(PROJECT_ID, sessionA);
        controller.synchronize(PROJECT_ID, sessionB);

        var captor = org.mockito.ArgumentCaptor.forClass(ProjectChange.class);
        verify(messagingTemplate, org.mockito.Mockito.times(2))
            .convertAndSend(eq(DESTINATION), captor.capture());

        List<ProjectChange> observed = captor.getAllValues();
        assertEquals(List.of(sessionA, sessionB), observed);
        assertEquals(NOTE_ID, observed.get(0).targetId());
        assertEquals(NOTE_ID, observed.get(1).targetId());
        assertTrue(observed.get(0).userId().equals("session-a"));
        assertTrue(observed.get(1).userId().equals("session-b"));
    }

    @Test
    void stateRequestReplaysTrackCreatedBeforeAnotherUserConnects() {
        SimpMessagingTemplate messagingTemplate = mock(SimpMessagingTemplate.class);
        ProjectSyncController controller = new ProjectSyncController(messagingTemplate);
        ProjectChange addedTrack = new ProjectChange(
            PROJECT_ID,
            "user-a",
            "ADD_TRACK",
            "track-1",
            java.util.Map.of("name", "Piano"),
            1);

        controller.synchronize(PROJECT_ID, addedTrack);
        controller.synchronize(PROJECT_ID, new ProjectChange(
            PROJECT_ID, "user-b", "REQUEST_STATE", "", null, 2));

        var captor = org.mockito.ArgumentCaptor.forClass(ProjectChange.class);
        verify(messagingTemplate, org.mockito.Mockito.times(2))
            .convertAndSend(eq(DESTINATION), captor.capture());

        assertEquals(addedTrack, captor.getAllValues().get(0));
        assertEquals(addedTrack, captor.getAllValues().get(1));
    }

    @Test
    void placeholderProjectEditReplaysToASecondSession() {
        SimpMessagingTemplate messagingTemplate = mock(SimpMessagingTemplate.class);
        ProjectSyncController controller = new ProjectSyncController(messagingTemplate);
        ProjectChange projectEdit = new ProjectChange(
            PROJECT_ID,
            "session-a",
            "UPDATE_PROJECT",
            PROJECT_ID,
            java.util.Map.of("name", "Renamed demo"),
            1);

        controller.synchronize(PROJECT_ID, projectEdit);
        controller.synchronize(PROJECT_ID, new ProjectChange(
            PROJECT_ID, "session-b", "REQUEST_STATE", "", null, 2));

        var captor = org.mockito.ArgumentCaptor.forClass(ProjectChange.class);
        verify(messagingTemplate, org.mockito.Mockito.times(2))
            .convertAndSend(eq(DESTINATION), captor.capture());

        assertEquals(projectEdit, captor.getAllValues().get(1));
    }

    private static void sendEdits(
        ProjectSyncController controller,
        String userId,
        int editCount,
        CountDownLatch ready,
        CountDownLatch start
    ) {
        ready.countDown();
        try {
            start.await();
            for (int edit = 0; edit < editCount; edit++) {
                controller.synchronize(PROJECT_ID, change(userId, edit, 60 + edit));
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Concurrent edit task was interrupted", exception);
        }
    }

    private static ProjectChange change(String userId, int timestamp, int pitch) {
        return new ProjectChange(
            PROJECT_ID,
            userId,
            "EDIT_NOTE",
            NOTE_ID,
            java.util.Map.of("pitch", pitch),
            timestamp);
    }
}