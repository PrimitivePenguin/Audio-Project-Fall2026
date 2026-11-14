## 1. Basic User Management

Admin Account: 
Username: admin
Password: adminadmin


## 2. Manual Testing

### 2.1 Signup
Create an account at: 
https://audio-project-fall2026.onrender.com/signup

Username and password are required, email is not, both username and email must be unique.

### 2.2 Login/out
Login: https://audio-project-fall2026.onrender.com/login

Logout: https://audio-project-fall2026.onrender.com/

### 2.3 User vs Admin
The text beside "Role:" will say either ADMIN or USERbased on the account's role. Default is set to USER. Admin has access to the admin page which lets you change roles between ADMIN or USER. Changing your own role as admin is disable to prevent everyone from being unable to access it.

Test user account:
Username: johndoe
Password: johndoe

Admin Account: 
Username: admin
Password: adminadmin


## 3. Running Tests on UserInfo Locally

### 3.1 Setup

**Option A: Local H2 database (easiest, no Postgres or `.env` needed)**

Terminal 1. Localhost:8080
```
.\mvnw.cmd spring-boot:run "-Dspring-boot.run.profiles=local"
```
- Data is saved in `./data/` (gitignored). Delete that folder to reset.
- The local DB starts empty: sign up at http://localhost:8080/signup.
- To make yourself admin, open http://localhost:8080/h2-console (JDBC URL `jdbc:h2:file:./data/localdb;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE`, user `sa`, no password) and run:
  ```
  UPDATE users SET role_type = 'ADMIN' WHERE username = 'yourname';
  ```

**Option B: Real Postgres (same DB as Render)**

Put `DB_URL`, `DB_USER`, `DB_PASSWORD` in a `.env` file in the project root, then:
```
.\mvnw.cmd spring-boot:run
```

### 3.2 Running Tests on UserInfo

Run the tests in a separate terminal.

1. Only UserInfo tests
```
.\mvnw.cmd test -Dtest=UserInfoTest
```
2. One test method (put method name after #)
```
.\mvnw.cmd test -Dtest=UserInfoTest#yourMethodName
```
3. All tests
```
.\mvnw.cmd test
```
Result is at end of output



### 3.3 Current Limits on User Management:
- Automatic tests for User Info is done, however login/logout features can only be manually tested




## 4. To-Dos
- make it such that if you want to logout, you go to /settings, not to /login
- Make it such that when you login you're redirected elsewhere such as /home or simply / as it currently stays at login
- Update password or email
- Delete account
- Profile customizeability
- Have it remember the user (optional)