//go:build darwin && cgo

package nativewatch

/*
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/proc.h>
#include <sys/wait.h>
#include <signal.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

// Never reap in the observation path. The supervisor's direct child reserves the PGID even
// after it exits, so group cleanup does not race a reused PID.
static int observe_native_group(int pid, int *exited, int *quiet) {
  siginfo_t info;
  memset(&info, 0, sizeof(info));
  *exited = 0; *quiet = 0;
  if (waitid(P_PID, (id_t)pid, &info, WEXITED | WNOHANG | WNOWAIT) != 0) return errno;
  if (info.si_pid == 0) return 0;
  if (info.si_pid != pid) return EINVAL;
  *exited = 1;
  int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PGRP, pid };
  size_t bytes = 0;
  if (sysctl(mib, 4, NULL, &bytes, NULL, 0) != 0) return errno;
  const size_t max = sizeof(struct kinfo_proc) * 4096;
  if (bytes > max) return EOVERFLOW;
  size_t capacity = bytes + sizeof(struct kinfo_proc) * 16;
  if (capacity > max) capacity = max;
  struct kinfo_proc *rows = calloc(1, capacity);
  if (rows == NULL) return ENOMEM;
  bytes = capacity;
  if (sysctl(mib, 4, rows, &bytes, NULL, 0) != 0) { int err = errno; free(rows); return err; }
  if (bytes > capacity || bytes % sizeof(struct kinfo_proc) != 0) { free(rows); return EINVAL; }
  int all_dead = 1;
  for (size_t i = 0; i < bytes / sizeof(struct kinfo_proc); i++) {
    // KERN_PROC_PGRP selects this reserved group in the kernel, not through a PID/name search.
    if (rows[i].kp_proc.p_stat != SZOMB) { all_dead = 0; break; }
  }
  free(rows);
  *quiet = all_dead;
  return 0;
}
*/
import "C"
import "unsafe"

func supported() bool { return true }

func renameResource(old, next string) error {
	a, b := C.CString(old), C.CString(next)
	defer C.free(unsafe.Pointer(a))
	defer C.free(unsafe.Pointer(b))
	if C.renamex_np(a, b, C.RENAME_EXCL) != 0 {
		return ErrResources
	}
	return nil
}

func observeGroup(pid int) (groupState, error) {
	var exited, quiet C.int
	if C.observe_native_group(C.int(pid), &exited, &quiet) != 0 {
		return groupState{}, ErrObservation
	}
	return groupState{exited: exited != 0, quiet: quiet != 0}, nil
}
