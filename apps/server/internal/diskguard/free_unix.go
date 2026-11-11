//go:build !windows

package diskguard

import "golang.org/x/sys/unix"

func FreeBytes(path string) (uint64, error) {
    var info unix.Statfs_t
    if err:=unix.Statfs(path,&info);err!=nil {return 0,err}
    return uint64(info.Bavail)*uint64(info.Bsize),nil
}
