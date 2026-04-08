package sample

import "fmt"

// Greeter greets people.
type Greeter interface {
	Greet(name string) string
}

// Config holds settings.
type Config struct {
	Host string
	Port int
}

// NewConfig creates a Config with defaults.
func NewConfig(host string, port int) *Config {
	return &Config{Host: host, Port: port}
}

func helperPrivate() string {
	return fmt.Sprintf("private")
}
