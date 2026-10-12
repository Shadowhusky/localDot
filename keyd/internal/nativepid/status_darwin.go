//go:build darwin && cgo

package nativepid

/*
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/proc.h>
#include <stdlib.h>
static int members(int group,struct kinfo_proc **out,size_t *count){
 int mib[4]={CTL_KERN,KERN_PROC,KERN_PROC_PGRP,group};size_t n=0;
 if(sysctl(mib,4,NULL,&n,NULL,0)!=0 || n>sizeof(struct kinfo_proc)*32768)return -1;
 size_t cap=n+64*sizeof(struct kinfo_proc);*out=calloc(1,cap);if(!*out)return -1;n=cap;
 if(sysctl(mib,4,*out,&n,NULL,0)!=0 || n>cap || n%sizeof(struct kinfo_proc)){free(*out);*out=NULL;return -1;}
 *count=n/sizeof(struct kinfo_proc);return 0;
}
static long long seconds(struct kinfo_proc *p){return p->kp_proc.p_starttime.tv_sec;}
static long long micros(struct kinfo_proc *p){return p->kp_proc.p_starttime.tv_usec;}
*/
import "C"
import (
	"fmt"
	"unsafe"
)

func group(pid int) ([]member, error) {
	var data *C.struct_kinfo_proc
	var count C.size_t
	if C.members(C.int(pid), &data, &count) != 0 {
		return nil, unknown
	}
	defer C.free(unsafe.Pointer(data))
	rows := []member{}
	for _, p := range unsafe.Slice(data, int(count)) {
		rows = append(rows, member{int(p.kp_proc.p_pid), int(p.kp_eproc.e_ppid), int(p.kp_eproc.e_ucred.cr_uid), fmt.Sprintf("%d:%d", C.seconds(&p), C.micros(&p)), p.kp_proc.p_stat != C.SZOMB})
	}
	return rows, nil
}
