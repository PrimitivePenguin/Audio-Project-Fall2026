package com.cmpt276group18.audio_project.controller;

import java.util.UUID;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;

@Controller
public class ProjectPageController {
    @GetMapping("/project/{projectId}")
    public String projectPage(@PathVariable UUID projectId) {
        return "forward:/index.html";
    }
}
