package admin

import (
	"context"
	"errors"
	"net/http"

	"github.com/shadowhusky/localdot/keyd/internal/webpush"
)

// Pusher is keyd's Web Push egress: it signs with a key the daemon never sees and reaches only the
// browsers' push services.
type Pusher interface {
	PublicKey() (string, error)
	Send(ctx context.Context, req webpush.Request) (webpush.Result, error)
}

func (s *Server) pushKey(w http.ResponseWriter, _ *http.Request) {
	if s.Push == nil {
		fail(w, http.StatusServiceUnavailable, "unavailable", "phone notifications are not set up in this keyd")
		return
	}
	key, err := s.Push.PublicKey()
	if err != nil {
		pushFailure(w, err)
		return
	}
	reply(w, http.StatusOK, map[string]string{"publicKey": key})
}

func (s *Server) pushSend(w http.ResponseWriter, r *http.Request) {
	if s.Push == nil {
		fail(w, http.StatusServiceUnavailable, "unavailable", "phone notifications are not set up in this keyd")
		return
	}
	var req webpush.Request
	if !decode(w, r, &req) {
		return
	}
	res, err := s.Push.Send(r.Context(), req)
	if err != nil {
		pushFailure(w, err)
		return
	}
	reply(w, http.StatusOK, res)
}

// pushFailure never returns a store or dial error's own text: it is not the daemon's to see.
func pushFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, webpush.ErrNotPushService):
		fail(w, http.StatusBadRequest, "not-push-service", "the endpoint is not a browser push service")
	case errors.Is(err, webpush.ErrBadMessage):
		fail(w, http.StatusBadRequest, "bad-request", "the push message is malformed")
	case errors.Is(err, webpush.ErrKeyBlocked):
		fail(w, http.StatusConflict, "key-name-taken", "a key named webpush-vapid blocks phone notifications; remove that key")
	case errors.Is(err, webpush.ErrKeyDamaged):
		fail(w, http.StatusInternalServerError, "push-key-damaged", "the stored push key is unreadable")
	case errors.Is(err, webpush.ErrUnreachable):
		fail(w, http.StatusBadGateway, "unreachable", "the push service could not be reached")
	default:
		fail(w, http.StatusServiceUnavailable, "unavailable", "the push key is unavailable")
	}
}
