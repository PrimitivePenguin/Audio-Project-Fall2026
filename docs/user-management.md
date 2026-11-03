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

Terminal 1. Localhost:8080
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