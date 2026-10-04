package admin

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"io"
	"net/http"
)

// Exact field names and one occurrence per field keep the control wire aligned
// with the daemon DTO. Null is never interpreted as an omitted epoch.
type admissionBody struct{ write egress.ModelAdmissionWrite }

func (b *admissionBody) UnmarshalJSON(raw []byte) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	token, err := dec.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("expected admission object")
	}
	seen := map[string]bool{}
	for dec.More() {
		token, err = dec.Token()
		if err != nil {
			return err
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return errors.New("duplicate admission field")
		}
		seen[key] = true
		var value json.RawMessage
		if err = dec.Decode(&value); err != nil {
			return err
		}
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return errors.New("null admission field")
		}
		switch key {
		case "taskId":
			err = json.Unmarshal(value, &b.write.TaskID)
		case "generationId":
			err = json.Unmarshal(value, &b.write.GenerationID)
		case "state":
			err = json.Unmarshal(value, &b.write.State)
		case "expectedEpoch":
			var epoch uint64
			err = json.Unmarshal(value, &epoch)
			b.write.ExpectedEpoch = &epoch
		default:
			return errors.New("unknown admission field")
		}
		if err != nil {
			return err
		}
	}
	if _, err = dec.Token(); err != nil {
		return err
	}
	if err = dec.Decode(new(any)); err != io.EOF {
		return errors.New("expected one admission object")
	}
	return nil
}
func (s *Server) getModelAdmission(w http.ResponseWriter, r *http.Request) {
	snapshot, err := s.Manager.ModelAdmission(r.PathValue("id"))
	if err != nil {
		managerFailure(w, err)
		return
	}
	reply(w, http.StatusOK, snapshot)
}
func (s *Server) setModelAdmission(w http.ResponseWriter, r *http.Request) {
	var body admissionBody
	if !decode(w, r, &body) {
		return
	}
	snapshot, err := s.Manager.SetModelAdmission(r.PathValue("id"), body.write)
	if err != nil {
		managerFailure(w, err)
		return
	}
	reply(w, http.StatusOK, snapshot)
}
