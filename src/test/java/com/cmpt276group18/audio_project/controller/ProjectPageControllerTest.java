package com.cmpt276group18.audio_project.controller;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.forwardedUrl;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class ProjectPageControllerTest {
    @Test
    void projectUuidServesTheSameEditorEntryPoint() throws Exception {
        MockMvcBuilders.standaloneSetup(new ProjectPageController()).build()
                .perform(get("/project/" + UUID.randomUUID()))
                .andExpect(status().isOk())
                .andExpect(forwardedUrl("/index.html"));
    }
}
