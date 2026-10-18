# CMPT276 Project - Group 18

# What is the name of your web application?
TBD - (Team Browser DAW)

# Do we have a clear understanding of the problem?
- How is this problem solved currently (if at all)?
    - Currently, musicians collaborate digitally by sharing project files back and forth or by meeting in the same physical studio. These approaches can be time-consuming, inconvenient, and expensive, especially when collaborators live far apart.
- How will this project make life better? Is it educational or just for entertainment?
    - This project will make digital music collaboration more accessible and beginner-friendly by allowing users to create and edit music directly in a web browser. Users will be able to work on music projects without needing to install expensive or complicated music production software.
- Who is the target audience?
    - The target audience includes young musicians, beginners interested in digital music production, hobbyists, and people who want to experiment with creating music collaboratively.

# What is the scope of your project?
- Does this project have many individual features or one main feature with many subproblems? These are the 'epics' of your project.
- What are the epics?
    - User Management
    - Dashboard + Project Management
    - Sequencer, Playback + Export
    - Instruments + Effects
    - Collaboration
- Is the amount of work sufficient for five group members? A rough rule of thumb is that each group member should have one major feature.
    - The proposed epics appear to provide sufficient work for five group members, with each member potentially leading a major feature area. The final workload will depend on the complexity of the selected features and the amount of time required for integration and testing.

# Statement of Customer’s Needs and Problems
Users need an accesible and convenient way to create digital music without being limited by expensive software, unintuitive designs, or the difficulty of collaborating remotely. Exisitng workflows often include exchanging project files, leading to confusion over versions and making it difficult for multiple musicians to contribute to the same project.

Our customers need a beginner-friendly music production tool that runs in a web browser, allows them to create and edit musical sequences, and makes it easy to save, access, and share their work. They would benefit from being able to collaborate with other users remotely without requring everyone to use the same physical studio or complicated software setups.

# High level description of the features present in final delivery

The final application will be a browser based Digital Audio Workstation (DAW) designed to make music creation and collaboration more accessible.

- <b>User Management</b>: Users will be able to create accounts and log in to access and their saved music projects.
- <b>Dashboard and Project Management</b>: Users will be able to create, view, save, load, rename, export, and manage their music projects.
- <b>Sequence, Playback, and Export</b>: Users will be able to create musical sequences using a visual grid, add and remove notes, control playback, adjust tempo, and export their work in a supported format such as .wav.
- <b>Instruments and Effects</b>: Users will be able to share projects with other musicians and collaborate remotely.  This will include multiple users editing the same project or accessing shared project files.

The application will use Java and Spring Boot for server-side functionality, PostgreSQL for data persistence, and browser-based technologies for the interactive music editor and audio playback. The application will be deployed using Render.


