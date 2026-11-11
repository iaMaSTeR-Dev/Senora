// Package mediaindex builds byte-range HLS indexes without creating media files.
package mediaindex

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"math"
	"strings"
)

type Segment struct {
	Offset   int64
	Length   int64
	Start    float64
	Duration float64
}

type Index struct {
	Segments []Segment
	Duration float64
}

// Build makes one sequential read of the original object. Only transport
// tables, timestamps and keyframe offsets survive; compressed media is discarded.
// H.264, 188-byte MPEG-TS with independently decodable PAT/PMT boundaries only.
func Build(ctx context.Context, source io.Reader, size int64, progress func(int64)) (*Index, error) {
	r := bufio.NewReaderSize(source, 64<<10)
	var packet [188]byte
	pmt, video := -1, -1
	lastPAT, pesPAT := int64(-1), int64(-1)
	patHasVideo := false
	pts, first, maxPTS, previous := int64(-1), int64(-1), int64(-1), int64(-1)
	frameTicks := int64(1 << 62)
	zeros, wantNAL, foundVCL := 0, false, false
	index := &Index{}
	addKey := func() {
		if pts < 0 || pesPAT < 0 || patHasVideo {
			return
		}
		if first < 0 {
			first = pts
		}
		t := float64(pts-first) / 90000
		if t < 0 {
			return
		}
		if len(index.Segments) > 0 {
			last := &index.Segments[len(index.Segments)-1]
			if t-last.Start < 6 || pesPAT <= last.Offset {
				return
			}
			last.Length = pesPAT - last.Offset
			last.Duration = t - last.Start
		}
		index.Segments = append(index.Segments, Segment{Offset: pesPAT, Start: t})
	}
	var offset int64
	for ; ; offset += 188 {
		if offset%(188*1024) == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if progress != nil {
				progress(offset)
			}
		}
		_, err := io.ReadFull(r, packet[:])
		if err == io.EOF {
			break
		}
		if err == io.ErrUnexpectedEOF {
			break
		} // trailing incomplete packet is not indexed
		if err != nil {
			return nil, err
		}
		p := packet[:]
		if p[0] != 0x47 || p[1]&0x80 != 0 || p[3]&0xc0 != 0 {
			return nil, fmt.Errorf("unsupported or damaged transport stream")
		}
		pid := int(p[1]&31)<<8 | int(p[2])
		if p[3]&16 == 0 {
			continue
		}
		a := 4
		if p[3]&32 != 0 {
			a += 1 + int(p[4])
		}
		if a >= len(p) {
			continue
		}
		p = p[a:]
		start := packet[1]&64 != 0
		if (pid == 0 || pid == pmt) && start {
			pointer := int(p[0]) + 1
			if pointer >= len(p) {
				continue
			}
			s := p[pointer:]
			if len(s) < 12 {
				continue
			}
			end := 3 + (int(s[1]&15)<<8 | int(s[2])) - 4
			if end > len(s) {
				return nil, fmt.Errorf("multi-packet transport tables not supported")
			}
			if pid == 0 && s[0] == 0 {
				for j := 8; j+4 <= end; j += 4 {
					if s[j] != 0 || s[j+1] != 0 {
						pmt = int(s[j+2]&31)<<8 | int(s[j+3])
						break
					}
				}
				lastPAT = offset
				patHasVideo = false
			} else if pid == pmt && s[0] == 2 {
				for j := 12 + (int(s[10]&15)<<8 | int(s[11])); j+5 <= end; {
					if s[j] == 0x1b {
						video = int(s[j+1]&31)<<8 | int(s[j+2])
						break
					}
					j += 5 + (int(s[j+3]&15)<<8 | int(s[j+4]))
				}
			}
			continue
		}
		if pid != video {
			continue
		}
		if start {
			zeros = 0
			wantNAL = false
			foundVCL = false
			pts = -1
			pesPAT = lastPAT
			if len(p) < 14 || p[0] != 0 || p[1] != 0 || p[2] != 1 || p[7]&0x80 == 0 {
				continue
			}
			raw := int64(p[9]&14)<<29 | int64(p[10])<<22 | int64(p[11]&254)<<14 | int64(p[12])<<7 | int64(p[13]>>1)
			pts = raw
			if maxPTS >= 0 { // nearest 33-bit epoch, including reordered B frames
				const wrap int64 = 1 << 33
				pts += (maxPTS / wrap) * wrap
				if pts-maxPTS > wrap/2 {
					pts -= wrap
				} else if maxPTS-pts > wrap/2 {
					pts += wrap
				}
				if pts < maxPTS-90000*2 {
					return nil, fmt.Errorf("transport timestamp discontinuity")
				}
			}
			if previous >= 0 && pts > previous && pts-previous < frameTicks {
				frameTicks = pts - previous
			}
			previous = pts
			if pts > maxPTS {
				maxPTS = pts
			}
			header := 9 + int(p[8])
			if header > len(p) {
				continue
			}
			p = p[header:]
		}
		if foundVCL || pts < 0 {
			continue
		}
		for _, b := range p {
			if wantNAL {
				kind := b & 31
				wantNAL = false
				if kind >= 1 && kind <= 5 {
					if kind == 5 {
						addKey()
					}
					patHasVideo = true
					foundVCL = true
					break
				}
			}
			if b == 0 {
				zeros++
			} else {
				if b == 1 && zeros >= 2 {
					wantNAL = true
				}
				zeros = 0
			}
		}
		if len(index.Segments) > 50000 {
			return nil, fmt.Errorf("video index too large")
		}
	}
	if size > 0 && offset != size-size%188 {
		return nil, fmt.Errorf("incomplete transport source")
	}
	if len(index.Segments) == 0 || first < 0 || maxPTS <= first {
		return nil, fmt.Errorf("no independent H.264 transport segments found")
	}
	if frameTicks == 1<<62 {
		frameTicks = 3600
	}
	index.Duration = float64(maxPTS-first+frameTicks) / 90000
	last := &index.Segments[len(index.Segments)-1]
	last.Length = offset - last.Offset
	last.Duration = index.Duration - last.Start
	if last.Duration <= 0 || last.Length <= 0 {
		return nil, fmt.Errorf("invalid final transport segment")
	}
	for _, segment := range index.Segments {
		if segment.Length > 64<<20 {
			return nil, fmt.Errorf("transport segment exceeds bounded playback size")
		}
	}
	if progress != nil {
		progress(offset)
	}
	return index, nil
}

func (index *Index) Playlist(source string) string {
	var text strings.Builder
	longest := 1.0
	for _, s := range index.Segments {
		longest = math.Max(longest, s.Duration)
	}
	fmt.Fprintf(&text, "#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:%d\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-INDEPENDENT-SEGMENTS\n", int(math.Ceil(longest)))
	for _, s := range index.Segments {
		fmt.Fprintf(&text, "#EXTINF:%.6f,\n#EXT-X-BYTERANGE:%d@%d\n%s\n", s.Duration, s.Length, s.Offset, source)
	}
	text.WriteString("#EXT-X-ENDLIST\n")
	return text.String()
}
