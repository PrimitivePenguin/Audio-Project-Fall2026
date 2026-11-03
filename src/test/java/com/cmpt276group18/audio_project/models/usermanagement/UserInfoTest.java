package com.cmpt276group18.audio_project.models.usermanagement;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.LocalDateTime;
import java.util.Set;
import java.util.stream.Collectors;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import jakarta.validation.ValidatorFactory;

// Plain unit tests for the UserInfo model: no Spring, no database, so they run fast.
// The test lives in the same package as UserInfo so it can call the protected onCreate()/onUpdate().
class UserInfoTest {
    private static ValidatorFactory factory;
    private static Validator validator;

    @BeforeAll
    static void setUpValidator() {
        // The same validator Spring uses to check @NotBlank, @Size, @Email on forms
        factory = Validation.buildDefaultValidatorFactory();
        validator = factory.getValidator();
    }

    @AfterAll
    static void closeValidator() {
        factory.close();
    }

    // A user that passes every rule; each test changes one field to break it
    private UserInfo validUser() {
        return new UserInfo("alice", "secret123", "alice@sfu.ca");
    }

    // Returns the names of the fields that failed validation, e.g. {"username"}
    private Set<String> invalidFields(UserInfo user) {
        Set<ConstraintViolation<UserInfo>> violations = validator.validate(user);
        return violations.stream()
                .map(v -> v.getPropertyPath().toString())
                .collect(Collectors.toSet());
    }
    // ---------- Constructor and defaults ----------

    @Test
    void constructorSetsFields() {
        UserInfo user = validUser();

        assertEquals("alice", user.getUsername());
        assertEquals("secret123", user.getPassword());
        assertEquals("alice@sfu.ca", user.getEmail());
    }

    @Test
    void newUserIsRoleUserByDefault() {
        assertEquals(UserInfo.RoleType.USER, validUser().getRoleType());
        assertEquals(UserInfo.RoleType.USER, new UserInfo().getRoleType());
    }

    @Test
    void idIsEmptyUntilSaved() {
        // The database picks the id, so a new object has none yet
        assertNull(validUser().getId());
    }

    // ---------- Email cleanup ----------

    @Test
    void emailIsTrimmedAndLowercased() {
        UserInfo user = validUser();
        user.setEmail("  Alice@SFU.ca  ");

        assertEquals("alice@sfu.ca", user.getEmail());
    }

    @Test
    void constructorAlsoCleansEmail() {
        UserInfo user = new UserInfo("alice", "secret123", "  Alice@SFU.ca ");

        assertEquals("alice@sfu.ca", user.getEmail());
    }

    @Test
    void blankEmailBecomesNull() {
        // "" would clash with the unique rule; null does not
        UserInfo user = validUser();

        user.setEmail("");
        assertNull(user.getEmail());

        user.setEmail("   ");
        assertNull(user.getEmail());

        user.setEmail(null);
        assertNull(user.getEmail());
    }

    // ---------- Timestamps ----------

    @Test
    void onCreateSetsBothTimestamps() {
        UserInfo user = validUser();
        user.onCreate();

        assertNotNull(user.getCreatedAt());
        assertEquals(user.getCreatedAt(), user.getUpdatedAt());
    }

    @Test
    void onUpdateChangesOnlyUpdatedAt() {
        UserInfo user = validUser();
        LocalDateTime created = LocalDateTime.of(2026, 1, 1, 12, 0);
        user.setCreatedAt(created);
        user.setUpdatedAt(created);

        user.onUpdate();

        assertEquals(created, user.getCreatedAt());
        assertTrue(user.getUpdatedAt().isAfter(created));
    }

        void usernameMaxIs50Characters() {
        UserInfo user = validUser();

        user.setUsername("a".repeat(50));
        assertTrue(invalidFields(user).isEmpty());

        user.setUsername("a".repeat(51));
        assertEquals(Set.of("username"), invalidFields(user));
    }

    @Test
    void passwordIsRequired() {
        UserInfo user = validUser();
        user.setPassword("");

        assertTrue(invalidFields(user).contains("password"));
    }

    @Test
    void passwordMinIs6Characters() {
        UserInfo user = validUser();

        user.setPassword("123456");
        assertTrue(invalidFields(user).isEmpty());

        user.setPassword("12345");
        assertEquals(Set.of("password"), invalidFields(user));
    }

    @Test
    void emailIsOptional() {
        UserInfo user = validUser();
        user.setEmail(null);

        assertTrue(invalidFields(user).isEmpty());
    }

    @Test
    void emailMustLookLikeAnEmail() {
        UserInfo user = validUser();
        user.setEmail("not-an-email");

        assertEquals(Set.of("email"), invalidFields(user));
    }

    @Test
    void commentMaxIs500Characters() {
        UserInfo user = validUser();

        user.setComment("x".repeat(500));
        assertTrue(invalidFields(user).isEmpty());

        user.setComment("x".repeat(501));
        assertEquals(Set.of("comment"), invalidFields(user));
    }
}