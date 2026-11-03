## 1. Basic User Management

http://localhost:8080/h2-console
Login to h2-console to view database: 
- JDBC URL: jdbc:h2:mem:jukebox
- User Name: sa (stands for system administrator))
- Password: Leave empty, currently there is none

Click on "USERS" and run the command to see the database

NOTE: This is a test, change the values so that no one can log in easily, turning it into an environmental variable

### 1.1 Running Tests on UserInfo

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



### 1.2 Current Limits on User Management:
- Restarting the app deletes all data
- No home page after login yet
- Tests for User Info is done, however login/logout features can only be manually tested

## 2. Manual Testing

Signup: http://localhost:8080/signup

Login: http://localhost:8080/login

Note: 
- logging in / out / signing up from homepage is currently not implemented
- if you are logged in, you must go to http://localhost:8080/login in order to logout

### 2.1 Signup
Create an account at: 
http://localhost:8080/signup

Username and password are required, email is not, both username and email must be unique.

### 2.2 Login/out
Login: http://localhost:8080/login

Logout (also at): http://localhost:8080/login

### 2.3 User vs Admin
The text beside "Role:" will say either "ADMIN" or "USER" based on the account's role. Default is set to USER, as such to change it to ADMIN you have to go to http://localhost:8080/h2-console and log into the h2-console with the credential above.

Then, paste the following into the textbox and run it:
```
UPDATE users SET role_type = 'ADMIN' WHERE username = 'testnamehere';
```
Once run and you go back to http://localhost:8080/login, it will show "ADMIN" in red instead of "USER" in blue like before. If you want to change from ADMIN to USER, replace 'ADMIN' with 'USER'


## To-Dos
- Implement http://localhost:8080/logout as it currently shows errors
- make it such that if you want to logout, you go to /settings, not to /login