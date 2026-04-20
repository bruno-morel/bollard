package com.example.b;

import com.example.a.ServiceA;

public class ServiceB {
  public String go() {
    return new ServiceA().run();
  }
}
