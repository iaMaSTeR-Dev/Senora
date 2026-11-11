package mediaindex

import (
	"context"
	"io"
	"sync"
	"sync/atomic"
	"time"
)

type OpenSource func(context.Context) (io.ReadCloser, error)
type entry struct {
	index   *Index
	err     error
	read    atomic.Int64
	touched time.Time
	done    bool
}

// Cache retains metadata only. At most one scan and 16 completed indexes exist;
// unused indexes expire and scans stop when the requesting viewers disappear.
type Cache struct {
	mu      sync.Mutex
	entries map[string]*entry
	busy    bool
}
type Status struct {
	Index  *Index
	Read   int64
	Failed bool
}

func NewCache() *Cache { return &Cache{entries: make(map[string]*entry)} }

func (c *Cache) Get(key string, size int64, open OpenSource) Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for k, e := range c.entries {
		if e.done && (now.Sub(e.touched) > 30*time.Minute || (e.err != nil && now.Sub(e.touched) > 10*time.Second)) {
			delete(c.entries, k)
		}
	}
	if e := c.entries[key]; e != nil {
		e.touched = now
		return Status{e.index, e.read.Load(), e.err != nil}
	}
	if c.busy {
		return Status{}
	}
	if len(c.entries) >= 16 {
		var oldest string
		var when time.Time
		for k, e := range c.entries {
			if e.done && (when.IsZero() || e.touched.Before(when)) {
				oldest = k
				when = e.touched
			}
		}
		delete(c.entries, oldest)
	}
	e := &entry{touched: now}
	c.entries[key] = e
	c.busy = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
		defer cancel()
		stop := make(chan struct{})
		defer close(stop)
		go func() {
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-stop:
					return
				case <-ticker.C:
					c.mu.Lock()
					idle := time.Since(e.touched) > 30*time.Second
					c.mu.Unlock()
					if idle {
						cancel()
						return
					}
				}
			}
		}()
		reader, err := open(ctx)
		var index *Index
		if err == nil {
			index, err = Build(ctx, reader, size, func(n int64) { e.read.Store(n) })
			reader.Close()
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		e.index = index
		e.err = err
		e.done = true
		c.busy = false
		if ctx.Err() != nil {
			delete(c.entries, key)
		}
	}()
	return Status{}
}
