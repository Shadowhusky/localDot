package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/canaryrun"
)

// Actual Go command transport with an inert gateway; no listener, Docker or credential store.
func TestNodeCanaryFixture(t *testing.T) {
	if os.Getenv("LOCALDOT_NODE_CANARY_FIXTURE") != "1" {
		return
	}
	directory := os.Getenv("LOCALDOT_NODE_CANARY_DIRECTORY")
	lease := os.NewFile(3, "fixture-lease")
	session := &fakeCanarySession{ready: canaryrun.Ready{V: 1, Type: "ready", RunID: "run-fixture", CellID: "cell-fixture", SyntheticSecret: "canary-synthetic-only"}, closed: make(chan struct{})}
	code := runCanaryWith([]string{"--directory", directory, "--cell", "cell-fixture", "--run", "run-fixture"}, os.Stdin, os.Stdout, os.Stderr, lease,
		func(context.Context, canaryrun.Config) (canarySession, error) { return session, nil })
	os.Exit(code)
}

func TestCanaryActualNodeSocketpairTransport(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("Node is required for actual transport acceptance")
	}
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	const script = `
import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
const [binary,directory]=process.argv.slice(1),fd=openSync(directory,'r');
const child=spawn(binary,['-test.run=^TestNodeCanaryFixture$'],{
  env:{LOCALDOT_NODE_CANARY_FIXTURE:'1',LOCALDOT_NODE_CANARY_DIRECTORY:directory,GORACE:'atexit_sleep_ms=0'},
  stdio:['pipe','pipe','pipe',fd],cwd:directory
});closeSync(fd);
let pending='',errors='',receipts=[];
const deadline=setTimeout(()=>child.kill('SIGKILL'),5000);
child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
child.stderr.on('data',b=>{errors+=b;if(errors.length>8192)child.kill('SIGKILL')});
child.stdout.on('data',b=>{
  pending+=b;if(pending.length>8192){child.kill('SIGKILL');return}
  while(pending.includes('\n')){
    const end=pending.indexOf('\n'),row=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);receipts.push(row);
    if(row.type==='ready')child.stdin.end();
  }
});
const [code,signal]=await new Promise(resolve=>child.once('close',(...args)=>resolve(args)));
clearTimeout(deadline);
if(code!==0||signal||pending||receipts.length!==2||receipts[0].type!=='ready'||receipts[1].type!=='closed'||!receipts[1].gatewayClosed||errors!=='canary:run-fixture:ready\ncanary:run-fixture:closed\n')process.exitCode=1;
else console.log(JSON.stringify({receipts:receipts.length,closed:true}));
`
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, node, "--input-type=module", "-e", script, os.Args[0], directory)
	command.Env = []string{"PATH=" + os.Getenv("PATH")}
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("actual Node canary transport failed: %v; output bytes=%d", err, len(output))
	}
	var result struct {
		Receipts int
		Closed   bool
	}
	if json.Unmarshal(output, &result) != nil || result.Receipts != 2 || !result.Closed {
		t.Fatal("Node transport receipt failed")
	}
}
