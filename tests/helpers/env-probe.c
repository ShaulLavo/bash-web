#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
extern char **environ;
__attribute__((import_module("runtime_proc"), import_name("cwd")))
extern int process_cwd(char *, int);
int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "spin") == 0) {
    FILE *ready = fopen("/tmp/spec/ready", "w");
    if (!ready) return 98;
    fputs("ready", ready);
    fclose(ready);
    while (1) { }
  }
  if (argc > 1 && strcmp(argv[1], "exit") == 0) return atoi(argv[2]);
  char cwd[4096];
  int length = process_cwd(cwd, sizeof cwd);
  if (length < 0 || length >= sizeof cwd) return 99;
  cwd[length] = 0;
  printf("cwd=<%s>\n", cwd);
  for (int i = 0; i < argc; i++) printf("arg%d=<%s>\n", i, argv[i]);
  for (char **entry = environ; *entry; entry++) printf("env=<%s>\n", *entry);
  fprintf(stderr, "probe stderr\n");
  return 23;
}
