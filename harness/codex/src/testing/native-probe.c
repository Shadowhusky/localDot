#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sandbox.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

// Owned native acceptance executable. It emits outcomes, never file bytes or env values.
static int result(int ok, int error) {
  printf("{\"ok\":%s,\"errno\":%d}\n", ok ? "true" : "false", error);
  return 0;
}
static int wait_fd(int fd, int writing) {
  fd_set set;
  FD_ZERO(&set);
  FD_SET(fd, &set);
  struct timeval timeout = {2, 0};
  int n = select(fd + 1, writing ? NULL : &set, writing ? &set : NULL, NULL, &timeout);
  if (n == 0) errno = ETIMEDOUT;
  return n > 0;
}
int main(int argc, char **argv) {
  if (argc < 3) return 64;
  if (!strcmp(argv[1], "nested")) {
    char *message = NULL;
    errno = 0;
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    int status = sandbox_init("(version 1)(allow default)", 0, &message);
    int error = errno;
    if (message) sandbox_free_error(message);
#pragma clang diagnostic pop
    return result(status == 0, status == 0 ? 0 : error);
  }
  if (!strcmp(argv[1], "read") || !strcmp(argv[1], "write")) {
    int writing = !strcmp(argv[1], "write");
    int fd = open(argv[2], writing ? O_WRONLY | O_CREAT | O_APPEND : O_RDONLY, 0600);
    if (fd < 0) return result(0, errno);
    char byte = 'x';
    ssize_t n = writing ? write(fd, &byte, 1) : read(fd, &byte, 1);
    int error = n < 0 ? errno : 0;
    close(fd);
    return result(n >= 0, error);
  }
  if (!strcmp(argv[1], "directory")) {
    DIR *dir = opendir(argv[2]);
    if (!dir) return result(0, errno);
    errno = 0;
    (void)readdir(dir);
    int error = errno;
    closedir(dir);
    return result(error == 0, error);
  }
  if (!strcmp(argv[1], "environment")) {
    const char *names[] = {"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY",
                           "LOCALDOT_INSTALL_TOKEN", "HTTP_PROXY_AUTH", "GITHUB_TOKEN"};
    int clean = 1;
    for (unsigned int i = 0; i < sizeof(names) / sizeof(names[0]); i++)
      if (getenv(names[i])) clean = 0;
    const char *home = getenv("CODEX_HOME");
    return result(clean && home && !strcmp(home, argv[2]), 0);
  }
  int unix_socket = !strcmp(argv[1], "unix");
  int accepting = !strcmp(argv[1], "accept");
  int binding = accepting || !strcmp(argv[1], "bind");
  if (!unix_socket && !binding && strcmp(argv[1], "connect")) return 64;
  if (!unix_socket && argc != 4) return 64;
  int family = unix_socket ? AF_UNIX : strchr(argv[2], ':') ? AF_INET6 : AF_INET;
  int fd = socket(family, SOCK_STREAM, 0);
  if (fd < 0) return result(0, errno);
  struct sockaddr_storage storage;
  memset(&storage, 0, sizeof(storage));
  socklen_t length;
  if (unix_socket) {
    struct sockaddr_un *address = (struct sockaddr_un *)&storage;
    if (strlen(argv[2]) >= sizeof(address->sun_path)) return 64;
    address->sun_family = AF_UNIX;
    strcpy(address->sun_path, argv[2]);
    length = sizeof(*address);
  } else {
    char *end;
    long port = strtol(argv[3], &end, 10);
    if (*end || port < 0 || port > 65535) return 64;
    if (family == AF_INET) {
      struct sockaddr_in *address = (struct sockaddr_in *)&storage;
      address->sin_family = AF_INET;
      address->sin_port = htons((unsigned short)port);
      if (inet_pton(AF_INET, argv[2], &address->sin_addr) != 1) return 64;
      length = sizeof(*address);
    } else {
      struct sockaddr_in6 *address = (struct sockaddr_in6 *)&storage;
      address->sin6_family = AF_INET6;
      address->sin6_port = htons((unsigned short)port);
      if (inet_pton(AF_INET6, argv[2], &address->sin6_addr) != 1) return 64;
      int only_v6 = 1;
      if (setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &only_v6, sizeof(only_v6)) != 0)
        return result(0, errno);
      length = sizeof(*address);
    }
  }
  int success;
  if (binding) {
    success = bind(fd, (struct sockaddr *)&storage, length) == 0 && listen(fd, 1) == 0;
    if (success && accepting) {
      fputs("READY\n", stderr);
      fflush(stderr);
      success = wait_fd(fd, 0);
      if (success) {
        int peer = accept(fd, NULL, NULL);
        success = peer >= 0;
        if (peer >= 0) close(peer);
      }
    }
  } else {
    if (fcntl(fd, F_SETFL, O_NONBLOCK) != 0) return result(0, errno);
    success = connect(fd, (struct sockaddr *)&storage, length) == 0;
    if (!success && errno == EINPROGRESS && wait_fd(fd, 1)) {
      int error = 0;
      socklen_t size = sizeof(error);
      success = getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) == 0 && error == 0;
      if (error) errno = error;
    }
  }
  int error = success ? 0 : errno;
  close(fd);
  return result(success, error);
}
