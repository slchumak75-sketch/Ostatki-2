package server_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/slchumak75-sketch/Ostatki-2/internal/server"
)

func TestDesktopHeartbeatSilenceDoesNotTerminateServer(t *testing.T) {
	app := server.New(true)
	rec := httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/heartbeat", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatal(rec.Code)
	}
	app.StartDesktopWatchdog(time.Millisecond)
	// The old watchdog would terminate this connected client on its first 2-second tick.
	select {
	case <-app.ShutdownChan():
		t.Fatal("server stopped solely because browser heartbeats were paused")
	case <-time.After(2300 * time.Millisecond):
	}
	rec = httptest.NewRecorder()
	app.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatal("server unavailable after heartbeat pause")
	}
	app.Handler().ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/shutdown", nil))
	select {
	case <-app.ShutdownChan():
	case <-time.After(2 * time.Second):
		t.Fatal("explicit exit did not stop desktop server")
	}
}

func TestDesktopDetachCancelledByReconnect(t *testing.T) {
	app := server.New(true)
	h := app.Handler()
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/heartbeat", nil))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/client-detach", nil))
	// A page reload/resume sends a fresh heartbeat and cancels the pending close.
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/heartbeat", nil))
	app.StartDesktopWatchdog(time.Millisecond)
	select {
	case <-app.ShutdownChan():
		t.Fatal("reload stopped the server despite reconnect")
	case <-time.After(2300 * time.Millisecond):
	}
	// A genuinely detached page still gets eventual cleanup, without a heartbeat-only deadline.
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/client-detach", nil))
	select {
	case <-app.ShutdownChan():
	case <-time.After(3 * time.Second):
		t.Fatal("detached window never cleaned up")
	}
}
