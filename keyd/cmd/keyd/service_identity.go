package main

import "github.com/shadowhusky/localdot/keyd/internal/admin"

func managedServiceFromEnv(lookup func(string) (string, bool)) (*admin.ServiceIdentity, error) {
	raw, present := lookup("LOCALDOT_SERVICE_IDENTITY")
	if !present {
		return nil, nil
	}
	return admin.ParseServiceIdentity(raw)
}
