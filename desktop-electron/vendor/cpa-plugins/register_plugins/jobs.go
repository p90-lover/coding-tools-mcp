package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
)

var errBusy = errors.New("Register job is already running")
var errStorage = errors.New("CPA auth storage is unavailable")
var errState = errors.New("Register import state could not be saved")

type authEntry struct {
	Name     string `json:"name"`
	Index    string `json:"auth_index"`
	Disabled bool   `json:"disabled"`
}
type ownership struct {
	SourceID       string `json:"source_id"`
	AccountID      int64  `json:"account_id"`
	Revision       string `json:"revision"`
	CredentialHash string `json:"credential_hash"`
}
type jobResult struct {
	ID    int64  `json:"id"`
	State string `json:"state"`
}
type exportedFile struct {
	ID       int64                      `json:"account_id"`
	Revision string                     `json:"revision"`
	JSON     map[string]json.RawMessage `json:"json"`
}

func validIDs(ids []int64) bool {
	if len(ids) < 1 || len(ids) > 100 {
		return false
	}
	seen := map[int64]bool{}
	for _, id := range ids {
		if id < 1 || id > 9007199254740991 || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}
func authName(source string, id int64) string {
	hash := sha256.Sum256([]byte(source))
	return "register_plugins-" + hex.EncodeToString(hash[:12]) + "-" + strconv.FormatInt(id, 10) + ".json"
}
func ledgerKey(source string, id int64) string { return source + ":" + strconv.FormatInt(id, 10) }
func credentialHash(auth map[string]json.RawMessage) string {
	credential := map[string]json.RawMessage{}
	for _, key := range []string{"type", "account_id", "email", "access_token", "refresh_token", "id_token"} {
		if value, ok := auth[key]; ok {
			credential[key] = value
		}
	}
	raw, _ := json.Marshal(credential)
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:])
}
func listAuths() ([]authEntry, error) {
	raw, err := hostCall("host.auth.list", map[string]any{})
	if err != nil {
		return nil, errStorage
	}
	var result struct {
		Files []authEntry `json:"files"`
	}
	if json.Unmarshal(raw, &result) != nil || len(result.Files) > 100000 {
		return nil, errStorage
	}
	return result.Files, nil
}
func existingAuth(source string, id int64) (map[string]json.RawMessage, string, error) {
	files, err := listAuths()
	if err != nil {
		return nil, "", err
	}
	name := authName(source, id)
	var match *authEntry
	for i := range files {
		if strings.EqualFold(files[i].Name, name) {
			if match != nil {
				return nil, "conflict", nil
			}
			match = &files[i]
		}
	}
	if match == nil {
		return nil, "missing", nil
	}
	if match.Index == "" {
		return nil, "conflict", nil
	}
	raw, err := hostCall("host.auth.get", map[string]string{"auth_index": match.Index})
	if err != nil {
		return nil, "", errStorage
	}
	var response struct {
		Name string                     `json:"name"`
		JSON map[string]json.RawMessage `json:"json"`
	}
	if json.Unmarshal(raw, &response) != nil || !strings.EqualFold(response.Name, name) || response.JSON == nil {
		return nil, "conflict", nil
	}
	var own ownership
	if json.Unmarshal(response.JSON["_register_plugins"], &own) != nil || own.SourceID != source || own.AccountID != id {
		return nil, "conflict", nil
	}
	var disabled bool
	_ = json.Unmarshal(response.JSON["disabled"], &disabled)
	if match.Disabled || disabled {
		return response.JSON, "disabled", nil
	}
	if own.CredentialHash == "" || own.CredentialHash != credentialHash(response.JSON) {
		return response.JSON, "cpa_newer", nil
	}
	return response.JSON, "owned", nil
}

func (e *engine) importFile(source string, f exportedFile) (jobResult, error) {
	result := jobResult{ID: f.ID, State: "failed"}
	if f.ID < 1 || f.Revision == "" || len(f.Revision) > 256 || f.JSON == nil {
		return result, nil
	}
	var provider, access string
	_ = json.Unmarshal(f.JSON["type"], &provider)
	_ = json.Unmarshal(f.JSON["access_token"], &access)
	if provider != "codex" || access == "" {
		return result, nil
	}
	existing, state, err := existingAuth(source, f.ID)
	if err != nil {
		return result, err
	}
	if state == "disabled" || state == "conflict" || state == "cpa_newer" {
		result.State = state
		return result, nil
	}
	key := ledgerKey(source, f.ID)
	e.mu.Lock()
	prior := e.state.Imported[key]
	e.mu.Unlock()
	// CPA may already have rotated its own copy. A repeated source revision must never roll it back.
	if prior == f.Revision {
		result.State = "unchanged"
		return result, nil
	}
	if state == "owned" {
		var marker ownership
		_ = json.Unmarshal(existing["_register_plugins"], &marker)
		if marker.Revision == f.Revision {
			if err = e.recordRevision(key, f.Revision); err != nil {
				return result, err
			}
			result.State = "unchanged"
			return result, nil
		}
		for _, name := range []string{"disabled", "priority", "prefix", "proxy_url", "excluded_models", "headers", "note", "websockets"} {
			if value, ok := existing[name]; ok {
				f.JSON[name] = value
			}
		}
	}
	f.JSON["_register_plugins"], _ = json.Marshal(ownership{SourceID: source, AccountID: f.ID, Revision: f.Revision, CredentialHash: credentialHash(f.JSON)})
	if _, err = hostCall("host.auth.save", map[string]any{"name": authName(source, f.ID), "json": f.JSON}); err != nil {
		return result, errStorage
	}
	if err = e.recordRevision(key, f.Revision); err != nil {
		return result, err
	}
	result.State = "imported"
	return result, nil
}

func (e *engine) importIDs(ctx context.Context, b *bridge, ids []int64) ([]jobResult, error) {
	if len(ids) == 0 {
		return []jobResult{}, nil
	}
	var response struct {
		Files []exportedFile `json:"files"`
	}
	if err := b.request(ctx, "POST", "/v1/export", map[string]any{"ids": ids}, &response); err != nil {
		return nil, err
	}
	wanted := map[int64]bool{}
	for _, id := range ids {
		wanted[id] = true
	}
	if len(response.Files) != len(ids) {
		return nil, errBridge
	}
	seen := map[int64]bool{}
	for _, f := range response.Files {
		if !wanted[f.ID] || seen[f.ID] {
			return nil, errBridge
		}
		seen[f.ID] = true
	}
	results := []jobResult{}
	for _, f := range response.Files {
		if ctx.Err() != nil {
			return nil, errBridge
		}
		result, err := e.importFile(b.SourceID, f)
		if err != nil {
			return results, err
		}
		results = append(results, result)
	}
	return results, nil
}

func (e *engine) refreshIDs(ctx context.Context, b *bridge, ids []int64) ([]jobResult, error) {
	allowed := []int64{}
	results := []jobResult{}
	for _, id := range ids {
		_, state, err := existingAuth(b.SourceID, id)
		if err != nil {
			return nil, err
		}
		if state != "owned" {
			results = append(results, jobResult{ID: id, State: state})
			continue
		}
		allowed = append(allowed, id)
	}
	if len(allowed) == 0 {
		return results, nil
	}
	var response struct {
		Results []struct {
			ID            int64 `json:"id"`
			OK            bool  `json:"ok"`
			RequiresLogin bool  `json:"requires_login"`
		} `json:"results"`
	}
	if err := b.request(ctx, "POST", "/v1/refresh", map[string]any{"ids": allowed}, &response); err != nil {
		return nil, err
	}
	wanted := map[int64]bool{}
	for _, id := range allowed {
		wanted[id] = true
	}
	seen := map[int64]bool{}
	rotated := []int64{}
	for _, r := range response.Results {
		if !wanted[r.ID] || seen[r.ID] {
			return nil, errBridge
		}
		seen[r.ID] = true
		if r.OK {
			rotated = append(rotated, r.ID)
		} else {
			state := "refresh_failed"
			if r.RequiresLogin {
				state = "requires_login"
			}
			results = append(results, jobResult{ID: r.ID, State: state})
		}
	}
	if len(seen) != len(allowed) {
		return nil, errBridge
	}
	imported, err := e.importIDs(ctx, b, rotated)
	return append(results, imported...), err
}

func (e *engine) run(ids []int64, refresh, automatic bool) (results []jobResult, err error) {
	if !automatic && !validIDs(ids) {
		return nil, errors.New("explicit_account_ids_required")
	}
	if !e.opMu.TryLock() {
		return nil, errBusy
	}
	defer e.opMu.Unlock()
	if !e.begin() {
		return nil, errBridge
	}
	defer e.wg.Done()
	e.mu.Lock()
	e.busy = true
	options := e.state.Settings
	e.mu.Unlock()
	defer func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		e.busy = false
		e.lastRun = time.Now().UTC().Format(time.RFC3339)
		e.lastResults = results
		e.lastError = ""
		if err != nil {
			e.lastError = err.Error()
		}
	}()
	if automatic && !options.AutoImport && !options.AutoRefresh {
		return []jobResult{}, nil
	}
	ctx, cancel := context.WithTimeout(e.ctx, 3*time.Minute)
	defer cancel()
	b, err := openBridge(e.cfg.Descriptor)
	if err != nil {
		return nil, err
	}
	var status sourceStatus
	if err = b.request(ctx, "GET", "/v1/status", nil, &status); err != nil {
		return nil, err
	}
	if !status.Ready {
		if err = b.request(ctx, "POST", "/v1/start", map[string]any{}, &status); err != nil || !status.Ready {
			return nil, errBridge
		}
	}
	accounts, err := b.accounts(ctx)
	if err != nil {
		return nil, err
	}
	eligible := map[int64]bool{}
	for _, a := range accounts {
		if a.Eligible && !a.Disabled {
			eligible[a.ID] = true
		}
	}
	if automatic {
		ids = []int64{}
		for id := range eligible {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	}
	for _, id := range ids {
		if !eligible[id] {
			return nil, errors.New("account_not_eligible")
		}
	}
	results = []jobResult{}
	for offset := 0; offset < len(ids); offset += 100 {
		end := min(offset+100, len(ids))
		batch := ids[offset:end]
		if automatic && options.AutoImport {
			r, e := e.importIDs(ctx, b, batch)
			results = append(results, r...)
			if e != nil {
				return results, e
			}
		}
		if refresh || (automatic && options.AutoRefresh) {
			r, e := e.refreshIDs(ctx, b, batch)
			results = append(results, r...)
			if e != nil {
				return results, e
			}
		} else if !automatic {
			r, e := e.importIDs(ctx, b, batch)
			results = append(results, r...)
			if e != nil {
				return results, e
			}
		}
	}
	return results, nil
}

func (e *engine) schedule() {
	defer close(e.done)
	for {
		e.mu.Lock()
		interval := e.state.Settings.IntervalSeconds
		e.mu.Unlock()
		timer := time.NewTimer(time.Duration(interval) * time.Second)
		select {
		case <-e.ctx.Done():
			timer.Stop()
			return
		case <-e.wake:
			timer.Stop()
		case <-timer.C:
		}
		_, _ = e.run(nil, false, true)
	}
}

type accountStatus struct {
	sourceAccount
	CPAState string `json:"cpa_state"`
}

func (e *engine) status() any {
	e.mu.Lock()
	result := map[string]any{"settings": e.state.Settings, "busy": e.busy, "last_run": e.lastRun, "last_error": e.lastError, "results": e.lastResults, "ready": false, "accounts": []accountStatus{}}
	e.mu.Unlock()
	b, err := openBridge(e.cfg.Descriptor)
	if err != nil {
		result["error"] = "Register is offline; open Register in Coding Tools or run Sync"
		return result
	}
	ctx, cancel := context.WithTimeout(e.ctx, 30*time.Second)
	defer cancel()
	var status sourceStatus
	if b.request(ctx, "GET", "/v1/status", nil, &status) != nil {
		result["error"] = "Register service is unavailable"
		return result
	}
	result["ready"] = status.Ready
	result["starting"] = status.Starting
	if !status.Ready {
		return result
	}
	accounts, err := b.accounts(ctx)
	if err != nil {
		result["error"] = "Register accounts are unavailable"
		return result
	}
	public := []accountStatus{}
	for _, a := range accounts {
		_, state, err := existingAuth(b.SourceID, a.ID)
		if err != nil {
			result["error"] = "CPA auth storage is unavailable"
			return result
		}
		public = append(public, accountStatus{sourceAccount: a, CPAState: state})
	}
	result["accounts"] = public
	return result
}
